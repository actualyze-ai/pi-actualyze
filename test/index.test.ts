import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import actualyzeExtension, { ACTUALYZE_PROVIDER_ID } from "../src/index.js";

describe("pi-actualyze extension entry", () => {
	it("exports the stable provider id", () => {
		expect(ACTUALYZE_PROVIDER_ID).toBe("actualyze");
	});

	it("registers the native Actualyze provider", () => {
		const registerProvider = vi.fn();
		actualyzeExtension({
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
		function load(): {
			registerFlag: ReturnType<typeof vi.fn>;
			provider: Provider;
			setFlag: (value: boolean | string | undefined) => void;
		} {
			let flagValue: boolean | string | undefined;
			const registerProvider = vi.fn();
			const registerFlag = vi.fn();
			actualyzeExtension({
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

		async function resolvedTarget(provider: Provider): Promise<string | undefined> {
			const result = await provider.auth.apiKey?.resolve({
				ctx: {
					env: async (name) => (name === "ACTUALYZE_API_KEY" ? "ambient-key" : undefined),
					fileExists: async () => false,
				},
				signal: new AbortController().signal,
			});
			return result?.env?.ACTUALYZE_TARGET;
		}

		it("registers a string-valued flag", () => {
			const { registerFlag } = load();
			expect(registerFlag).toHaveBeenCalledWith("actualyze-target", expect.objectContaining({ type: "string" }));
		});

		it("applies a flag value that pi sets after the extension loads", async () => {
			const { provider, setFlag } = load();
			setFlag("staging");
			await expect(resolvedTarget(provider)).resolves.toBe("staging");
		});

		it("keeps check() from throwing when getFlag throws on a stale runtime", async () => {
			const registerProvider = vi.fn();
			actualyzeExtension({
				registerProvider,
				registerFlag: vi.fn(),
				getFlag: () => {
					throw new Error("This extension ctx is stale");
				},
			} as unknown as ExtensionAPI);
			const provider = registerProvider.mock.calls[0]?.[0] as Provider;
			await expect(
				provider.auth.apiKey?.check?.({
					ctx: {
						env: async (name) => (name === "ACTUALYZE_API_KEY" ? "ambient-key" : undefined),
						fileExists: async () => false,
					},
					signal: new AbortController().signal,
				}),
			).resolves.toEqual({ type: "api_key", source: "ACTUALYZE_API_KEY" });
		});

		it("ignores a non-string flag value", async () => {
			// A non-string value falls through to the argv fallback, which finds
			// no --actualyze-target in the vitest worker's argv.
			const { provider, setFlag } = load();
			setFlag(true);
			await expect(resolvedTarget(provider)).resolves.toBe("app");
		});
	});
});
