import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { DEFAULT_REQUEST_BUDGET_MS, STARTUP_CATALOG_BUDGET_MS } from "../src/constants.js";
import actualyzeExtension, { ACTUALYZE_PROVIDER_ID } from "../src/index.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

const loopback = "http://127.0.0.1:8080/openai/v1";
const otherLoopback = "http://127.0.0.1:9090/openai/v1";
const namedModel = ["--provider", "actualyze", "--model", "model-a", "-p", "hi"];

/** `URL authorization` for every request the extension sent. */
function sent(network: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
	return network.mock.calls.map(
		([input, init]) =>
			`${input instanceof Request ? input.url : String(input)} ${new Headers(init?.headers).get("authorization") ?? ""}`,
	);
}

/** A fetch that never answers and fails only when its request is aborted. */
function unanswered(): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>(
		(_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	);
}

/** A fetch that answers with the catalog after `delayMs`, unless its request is aborted first. */
function answeredAfter(delayMs: number): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>(
		(_input, init) =>
			new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(() => resolve(jsonResponse({ data: [modelEntry("model-a")] })), delayMs);
				const signal = init?.signal;
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(signal.reason);
					},
					{ once: true },
				);
			}),
	);
}

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

	describe("catalog fetch at load", () => {
		const originalArgv = process.argv;
		let agentDir = "";

		// The factory reads pi's auth.json and models store from the agent
		// dir; each test starts with an empty one of its own.
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

		/** Writes pi's auth.json with `entry` as the stored Actualyze credential. */
		function storeCredential(entry: Record<string, unknown>): void {
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ actualyze: entry }));
		}

		/** A stored API key whose env names the loopback endpoint, or, with `null`, carries no env. */
		function storedKey(
			env: Record<string, string> | null = { ACTUALYZE_OPENAI_BASE_URL: loopback },
		): Record<string, unknown> {
			return { type: "api_key", key: "stored-key", ...(env ? { env } : {}) };
		}

		describe("when the command line names an Actualyze model", () => {
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

			// pi's request budget, not the shorter startup bound, applies when
			// the run names the model it must find.
			it(
				"waits past the startup bound for a named model's catalog",
				async () => {
					storeCredential(storedKey());
					const network = answeredAfter(STARTUP_CATALOG_BUDGET_MS + 1_000);
					const { models } = await loadWith(namedModel, network);
					expect(network).toHaveBeenCalledOnce();
					expect(models()).toMatchObject([{ id: "model-a", baseUrl: loopback }]);
				},
				DEFAULT_REQUEST_BUDGET_MS + 10_000,
			);
		});

		describe("when pi stores an Actualyze key", () => {
			const catalog = { data: [modelEntry("model-a")] };

			it("fetches the catalog once from the stored endpoint with the stored key when nothing is cached", async () => {
				storeCredential(storedKey());
				const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
				const { registerProvider, models } = await loadWith(["--no-session", "-p", "hi"], network);
				expect(sent(network)).toEqual([`${loopback}/models Bearer stored-key`]);
				expect(registerProvider).toHaveBeenCalledOnce();
				expect(models()).toMatchObject([{ id: "model-a", baseUrl: loopback }]);
			});

			it.each([
				{
					case: "the environment names another key and endpoint",
					args: [],
					env: { ACTUALYZE_API_KEY: "env-key", ACTUALYZE_OPENAI_BASE_URL: otherLoopback },
				},
				{
					case: "the run names a model and the environment names another key and endpoint",
					args: namedModel,
					env: { ACTUALYZE_API_KEY: "env-key", ACTUALYZE_OPENAI_BASE_URL: otherLoopback },
				},
				{
					case: "--actualyze-target names another target",
					args: ["--actualyze-target", "team"],
					env: { ACTUALYZE_API_KEY: "env-key" },
				},
			])("sends only the stored key, to the stored endpoint, when $case", async ({ args, env }) => {
				for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
				storeCredential(storedKey());
				const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
				await loadWith(args, network);
				expect(sent(network)).toEqual([`${loopback}/models Bearer stored-key`]);
			});

			// Each environment here also names a key, so it names a complete
			// configuration of its own.
			it.each([
				{
					case: "ACTUALYZE_TARGET names a target",
					stored: null,
					args: [],
					env: { ACTUALYZE_API_KEY: "env-key", ACTUALYZE_TARGET: "team" },
				},
				{
					case: "ACTUALYZE_OPENAI_BASE_URL names an endpoint",
					stored: { ACTUALYZE_TARGET: "-" },
					args: [],
					env: { ACTUALYZE_API_KEY: "env-key", ACTUALYZE_OPENAI_BASE_URL: otherLoopback },
				},
				{
					case: "--actualyze-target names a target",
					stored: null,
					args: ["--actualyze-target", "team"],
					env: { ACTUALYZE_API_KEY: "env-key" },
				},
			])(
				"sends nothing on a start that names no model when the stored entry names no endpoint and $case",
				async ({ stored, args, env }) => {
					for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
					storeCredential(storedKey(stored));
					const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
					const { registerProvider, models } = await loadWith(args, network);
					expect(network).not.toHaveBeenCalled();
					expect(registerProvider).toHaveBeenCalledOnce();
					expect(models()).toEqual([]);
				},
			);

			it.each<{ case: string; stored: Record<string, string> | null }>([
				{ case: "names no endpoint", stored: null },
				{ case: "names only the - target", stored: { ACTUALYZE_TARGET: "-" } },
				{ case: "names an invalid target", stored: { ACTUALYZE_TARGET: "not a label" } },
				{
					case: "names plain HTTP off loopback",
					stored: { ACTUALYZE_OPENAI_BASE_URL: "http://example.com/openai/v1" },
				},
			])(
				"fetches with the environment's own key and endpoint for a named model when the stored entry $case",
				async ({ stored }) => {
					vi.stubEnv("ACTUALYZE_API_KEY", "env-key");
					vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", otherLoopback);
					storeCredential(storedKey(stored));
					const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
					const { models } = await loadWith(namedModel, network);
					expect(sent(network)).toEqual([`${otherLoopback}/models Bearer env-key`]);
					expect(sent(network).some((request) => request.includes("stored-key"))).toBe(false);
					expect(models()).toMatchObject([{ id: "model-a", baseUrl: otherLoopback }]);
				},
			);

			// The stored key is usable, so these show that it never fills in the
			// key an environment-named endpoint lacks.
			it.each([
				{
					case: "ACTUALYZE_OPENAI_BASE_URL names an endpoint but no key does",
					args: namedModel,
					env: { ACTUALYZE_OPENAI_BASE_URL: otherLoopback },
				},
				{
					case: "--actualyze-target names a target but no key does",
					args: [...namedModel, "--actualyze-target", "team"],
					env: {},
				},
			])("sends nothing for a named model when the stored entry names no endpoint and $case", async ({ args, env }) => {
				for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
				storeCredential(storedKey(null));
				const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
				const { registerProvider, models } = await loadWith(args, network);
				expect(network).not.toHaveBeenCalled();
				expect(registerProvider).toHaveBeenCalledOnce();
				expect(models()).toEqual([]);
			});

			it("skips the fetch when pi's models store holds the stored endpoint's catalog", async () => {
				storeCredential(storedKey());
				const cached = parseCatalog(catalog, loopback);
				writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ actualyze: { models: cached } }));
				const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
				const { registerProvider } = await loadWith(["--no-session", "-p", "hi"], network);
				expect(network).not.toHaveBeenCalled();
				expect(registerProvider).toHaveBeenCalledOnce();
			});

			// pi runs a key that starts with `!` as a shell command and expands
			// `$NAME` from the environment. Each key is one visible-ASCII token,
			// as a usable key would be, so only its form keeps it from being
			// sent; STORED_KEY is set so that pi could expand the references.
			const ignored = [
				{ case: "a key pi runs as a command", entry: storedKeyWith("!stored-key-helper") },
				{ case: "a key that is an environment reference", entry: storedKeyWith("$STORED_KEY") },
				{ case: "a key that embeds an environment reference", entry: storedKeyWith("stored-$STORED_KEY") },
				{
					case: "an API key entry without a key",
					entry: { type: "api_key", env: { ACTUALYZE_OPENAI_BASE_URL: loopback } },
				},
				{
					case: "an OAuth entry",
					entry: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3_600_000 },
				},
			];

			function storedKeyWith(key: string): Record<string, unknown> {
				return { ...storedKey(), key };
			}

			it.each(ignored)("sends nothing on a start that names no model for $case", async ({ entry }) => {
				vi.stubEnv("STORED_KEY", "stored-key");
				storeCredential(entry);
				const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
				const { registerProvider, models } = await loadWith(["--no-session", "-p", "hi"], network);
				expect(network).not.toHaveBeenCalled();
				expect(registerProvider).toHaveBeenCalledOnce();
				expect(models()).toEqual([]);
			});

			it.each(ignored)(
				"fetches with the environment's key from the environment's endpoint for a named model and $case",
				async ({ entry }) => {
					vi.stubEnv("STORED_KEY", "stored-key");
					vi.stubEnv("ACTUALYZE_API_KEY", "env-key");
					vi.stubEnv("ACTUALYZE_OPENAI_BASE_URL", otherLoopback);
					storeCredential(entry);
					const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
					const { models } = await loadWith(namedModel, network);
					expect(sent(network)).toEqual([`${otherLoopback}/models Bearer env-key`]);
					expect(models()).toMatchObject([{ id: "model-a", baseUrl: otherLoopback }]);
				},
			);

			it.each(["1", "0"])("sends nothing with PI_OFFLINE=%s", async (offline) => {
				vi.stubEnv("PI_OFFLINE", offline);
				storeCredential(storedKey());
				const network = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
				const { registerProvider, models } = await loadWith(["--no-session", "-p", "hi"], network);
				expect(network).not.toHaveBeenCalled();
				expect(registerProvider).toHaveBeenCalledOnce();
				expect(models()).toEqual([]);
			});

			it("still registers the provider with no models when the stored endpoint refuses the connection", async () => {
				storeCredential(storedKey());
				const network = vi.fn<typeof fetch>(async () => {
					throw new TypeError("fetch failed");
				});
				const { registerProvider, models } = await loadWith(["--no-session", "-p", "hi"], network);
				expect(network).toHaveBeenCalledOnce();
				expect(registerProvider).toHaveBeenCalledOnce();
				expect(models()).toEqual([]);
			});

			// Timers never fire early, so without the startup bound the load
			// would last at least the full request budget.
			it(
				"gives up on a stored endpoint that never answers well within the request budget",
				async () => {
					storeCredential(storedKey());
					const network = unanswered();
					const started = performance.now();
					const { registerProvider, models } = await loadWith(["--no-session", "-p", "hi"], network);
					const elapsed = performance.now() - started;
					expect(network).toHaveBeenCalledOnce();
					expect(registerProvider).toHaveBeenCalledOnce();
					expect(models()).toEqual([]);
					expect(elapsed).toBeLessThan(DEFAULT_REQUEST_BUDGET_MS - 1_000);
				},
				DEFAULT_REQUEST_BUDGET_MS + 10_000,
			);
		});
	});
});
