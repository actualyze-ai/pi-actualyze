import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import actualyzeExtension, { ACTUALYZE_PROVIDER_ID } from "../src/index.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

describe("pi-actualyze extension entry", () => {
	it("exports the stable provider id", () => {
		expect(ACTUALYZE_PROVIDER_ID).toBe("actualyze");
	});

	it("registers the native Actualyze provider", async () => {
		const registerProvider = vi.fn();
		await actualyzeExtension({
			registerProvider,
			registerFlag: vi.fn(),
			getFlag: vi.fn(),
		} as unknown as ExtensionAPI);
		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({
			id: "actualyze",
			name: "Actualyze",
		});
	});

	describe("--actualyze-target flag", () => {
		async function load(): Promise<{
			registerFlag: ReturnType<typeof vi.fn>;
			provider: Provider;
			setFlag: (value: boolean | string | undefined) => void;
		}> {
			let flagValue: boolean | string | undefined;
			const registerProvider = vi.fn();
			const registerFlag = vi.fn();
			await actualyzeExtension({
				registerProvider,
				registerFlag,
				getFlag: (name: string) => (name === "actualyze-target" ? flagValue : undefined),
			} as unknown as ExtensionAPI);
			return {
				registerFlag,
				provider: registerProvider.mock.calls[0]?.[0] as Provider,
				setFlag: (value) => {
					flagValue = value;
				},
			};
		}

		async function resolvedTarget(provider: Provider, env: Record<string, string> = {}): Promise<string | undefined> {
			const values: Record<string, string> = { ACTUALYZE_API_KEY: "ambient-key", ...env };
			const result = await provider.auth.apiKey?.resolve({
				ctx: {
					env: async (name) => values[name],
					fileExists: async () => false,
				},
				signal: new AbortController().signal,
			});
			return result?.env?.ACTUALYZE_TARGET;
		}

		it("registers a string-valued flag", async () => {
			const { registerFlag } = await load();
			expect(registerFlag).toHaveBeenCalledWith("actualyze-target", expect.objectContaining({ type: "string" }));
		});

		it("applies a flag value that pi sets after the extension loads", async () => {
			const { provider, setFlag } = await load();
			setFlag("staging");
			await expect(resolvedTarget(provider)).resolves.toBe("staging");
		});

		it("keeps check() from throwing when getFlag throws on a stale runtime", async () => {
			const registerProvider = vi.fn();
			await actualyzeExtension({
				registerProvider,
				registerFlag: vi.fn(),
				getFlag: () => {
					throw new Error("This extension ctx is stale");
				},
			} as unknown as ExtensionAPI);
			const provider = registerProvider.mock.calls[0]?.[0] as Provider;
			const values: Record<string, string> = { ACTUALYZE_TARGET: "app", ACTUALYZE_API_KEY: "ambient-key" };
			await expect(
				provider.auth.apiKey?.check?.({
					ctx: {
						env: async (name) => values[name],
						fileExists: async () => false,
					},
					signal: new AbortController().signal,
				}),
			).resolves.toEqual({ type: "api_key", source: "ACTUALYZE_API_KEY" });
		});

		it("ignores a non-string flag value", async () => {
			// A non-string value falls through to the argv fallback, which finds
			// no --actualyze-target in the vitest worker's argv, and then to
			// ACTUALYZE_TARGET.
			const { provider, setFlag } = await load();
			setFlag(true);
			await expect(resolvedTarget(provider, { ACTUALYZE_TARGET: "team" })).resolves.toBe("team");
		});
	});

	describe("when the command line names an Actualyze model", () => {
		const loopback = "http://127.0.0.1:8080/openai/v1";
		const originalArgv = process.argv;
		let agentDir = "";

		// The factory reads pi's models store from the agent dir; keep it
		// empty and away from the developer's own pi installation.
		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "pi-actualyze-index-"));
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		});

		afterEach(() => {
			process.argv = originalArgv;
			vi.unstubAllGlobals();
			rmSync(agentDir, { recursive: true, force: true });
		});

		async function loadWith(
			args: string[],
			network: typeof fetch,
		): Promise<{ registerProvider: ReturnType<typeof vi.fn>; models: () => readonly unknown[] }> {
			process.argv = [originalArgv[0] ?? "node", "pi", ...args];
			vi.stubGlobal("fetch", network);
			const registerProvider = vi.fn();
			await actualyzeExtension({
				registerProvider,
				registerFlag: vi.fn(),
				getFlag: vi.fn(),
			} as unknown as ExtensionAPI);
			const provider = registerProvider.mock.calls[0]?.[0] as Provider;
			return { registerProvider, models: () => provider.getModels() };
		}

		it.each([
			{ args: ["--provider", "actualyze", "--model", "model-a", "-p", "hi"] },
			{ args: ["--model", "Actualyze/model-a", "-p", "hi"] },
		])("fetches the catalog before registering the provider for $args", async ({ args }) => {
			vi.stubEnv("ACTUALYZE_API_KEY", "run-key");
			vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", loopback);
			const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("model-a")] }));
			const { registerProvider, models } = await loadWith(args, network);
			expect(registerProvider).toHaveBeenCalledOnce();
			expect(models()).toMatchObject([{ id: "model-a", baseUrl: loopback }]);
			expect(String(network.mock.calls[0]?.[0])).toBe(`${loopback}/models`);
		});

		it.each([
			{ args: ["--model", "model-a"], offline: undefined },
			{ args: ["--provider", "other", "--model", "actualyze/model-a"], offline: undefined },
			{ args: ["--provider", "actualyze", "--model", "model-a"], offline: "1" },
		])("sends nothing at load for $args with PI_OFFLINE $offline", async ({ args, offline }) => {
			vi.stubEnv("ACTUALYZE_API_KEY", "run-key");
			vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", loopback);
			if (offline) vi.stubEnv("PI_OFFLINE", offline);
			const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("model-a")] }));
			const { registerProvider, models } = await loadWith(args, network);
			expect(registerProvider).toHaveBeenCalledOnce();
			expect(models()).toEqual([]);
			expect(network).not.toHaveBeenCalled();
		});

		it("skips the fetch when pi's models store lists the named model for the endpoint", async () => {
			vi.stubEnv("ACTUALYZE_API_KEY", "run-key");
			vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", loopback);
			const cached = parseCatalog({ data: [modelEntry("model-a")] }, loopback);
			writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ actualyze: { models: cached } }));
			const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("model-a")] }));
			const { registerProvider } = await loadWith(["--provider", "actualyze", "--model", "model-a"], network);
			expect(registerProvider).toHaveBeenCalledOnce();
			expect(network).not.toHaveBeenCalled();
		});

		it("fetches when pi's models store cannot be read", async () => {
			vi.stubEnv("ACTUALYZE_API_KEY", "run-key");
			vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", loopback);
			writeFileSync(join(agentDir, "models-store.json"), "{");
			const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("model-a")] }));
			const { models } = await loadWith(["--provider", "actualyze", "--model", "model-a"], network);
			expect(network).toHaveBeenCalledOnce();
			expect(models()).toMatchObject([{ id: "model-a" }]);
		});

		it("still registers the provider when the fetch fails", async () => {
			vi.stubEnv("ACTUALYZE_API_KEY", "run-key");
			vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", loopback);
			const network = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
			const { registerProvider, models } = await loadWith(["--provider", "actualyze", "--model", "model-a"], network);
			expect(network).toHaveBeenCalledOnce();
			expect(registerProvider).toHaveBeenCalledOnce();
			expect(models()).toEqual([]);
		});
	});
});
