import type {
	ApiKeyCredential,
	AuthContext,
	AuthInteraction,
	ImageApi,
	ImageModel,
	Model,
	ModelsPublication,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { ActualyzeConfigurationError } from "../src/endpoint.js";
import { createActualyzeProvider } from "../src/provider.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

function authContext(values: Record<string, string | undefined>): AuthContext {
	return {
		env: async (name) => values[name],
		fileExists: async () => false,
	};
}

function keyInteraction(key: string) {
	return {
		signal: new AbortController().signal,
		prompt: vi.fn(async () => key),
		notify: vi.fn(),
	};
}

function requestedHost(call: Parameters<typeof fetch> | undefined): string | undefined {
	const input = call?.[0];
	if (input === undefined) return undefined;
	return new URL(input instanceof Request ? input.url : input).hostname;
}

function credential(target = "customer", key = "secret"): ApiKeyCredential {
	return { type: "api_key", key, env: { ACTUALYZE_TARGET: target } };
}

function refreshContext(
	overrides: Partial<RefreshModelsContext> & Pick<RefreshModelsContext, "publish">,
): RefreshModelsContext {
	return {
		credential: credential(),
		allowNetwork: true,
		signal: new AbortController().signal,
		...overrides,
	};
}

const catalogPayload = { data: [modelEntry("model-a"), modelEntry("model-b")] };

describe("native Actualyze provider auth", () => {
	it("resolves stored fields before the selected target and ambient values", async () => {
		const { provider } = createActualyzeProvider({ target: () => "flagged" });
		const resolve = provider.auth.apiKey?.resolve;
		expect(resolve).toBeDefined();
		const result = await resolve?.({
			ctx: authContext({
				ACTUALYZE_TARGET: "ambient",
				ACTUALYZE_API_KEY: "ambient-key",
			}),
			credential: credential("stored", "stored-key"),
			signal: new AbortController().signal,
		});
		expect(result).toEqual({
			auth: {
				apiKey: "stored-key",
				baseUrl: "https://stored.actualyze.ai/openai/v1",
			},
			env: { ACTUALYZE_TARGET: "stored" },
			source: "stored credential",
		});
	});

	it("supports complete ambient auth and declines incomplete or invalid ambient auth", async () => {
		const { provider } = createActualyzeProvider();
		const resolve = provider.auth.apiKey?.resolve;
		await expect(
			resolve?.({
				ctx: authContext({
					ACTUALYZE_TARGET: "team",
					ACTUALYZE_API_KEY: "ambient-key",
				}),
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({
			auth: {
				apiKey: "ambient-key",
				baseUrl: "https://team.actualyze.ai/openai/v1",
			},
		});
		await expect(
			resolve?.({
				ctx: authContext({ ACTUALYZE_TARGET: "team" }),
				signal: new AbortController().signal,
			}),
		).resolves.toBeUndefined();
		await expect(
			resolve?.({
				ctx: authContext({
					ACTUALYZE_TARGET: "evil.example",
					ACTUALYZE_API_KEY: "ambient-key",
				}),
				signal: new AbortController().signal,
			}),
		).resolves.toBeUndefined();
		await expect(
			resolve?.({
				ctx: authContext({
					ACTUALYZE_TARGET: "team",
					ACTUALYZE_API_KEY: "bad key",
				}),
				signal: new AbortController().signal,
			}),
		).resolves.toBeUndefined();
	});

	it("surfaces stored-field corruption through resolve while check reports unconfigured", async () => {
		const { provider } = createActualyzeProvider();
		const corrupt: ApiKeyCredential = {
			type: "api_key",
			key: "ambient-key-still-valid",
			env: { ACTUALYZE_TARGET: "evil.example" },
		};
		await expect(
			provider.auth.apiKey?.resolve({
				ctx: authContext({}),
				credential: corrupt,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/one ASCII DNS label/u);
		await expect(
			provider.auth.apiKey?.check?.({
				ctx: authContext({}),
				credential: corrupt,
				signal: new AbortController().signal,
			}),
		).resolves.toBeUndefined();
	});

	it("throws for an invalid stored target even when the key is ambient", async () => {
		const { provider } = createActualyzeProvider();
		await expect(
			provider.auth.apiKey?.resolve({
				ctx: authContext({ ACTUALYZE_API_KEY: "ambient-key" }),
				credential: {
					type: "api_key",
					env: { ACTUALYZE_TARGET: "evil.example" },
				},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/one ASCII DNS label/u);
	});

	it("throws for an invalid stored key even when the target is ambient", async () => {
		const { provider } = createActualyzeProvider();
		await expect(
			provider.auth.apiKey?.resolve({
				ctx: authContext({ ACTUALYZE_TARGET: "customer" }),
				credential: { type: "api_key", key: "bad key" },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/visible-ASCII/u);
	});

	it("validates login against /models and installs the catalog immediately", async () => {
		const network = vi.fn<typeof fetch>(async () => jsonResponse(catalogPayload));
		const controller = createActualyzeProvider({
			fetch: network,
			target: () => "Customer",
		});
		const answers = ["login-secret"];
		const interaction: AuthInteraction = {
			signal: new AbortController().signal,
			prompt: vi.fn(async () => answers.shift() ?? ""),
			notify: vi.fn(),
		};

		await expect(
			controller.provider.auth.apiKey?.login?.(interaction as AuthInteraction & { signal: AbortSignal }),
		).resolves.toEqual(credential("customer", "login-secret"));
		expect(controller.getModels().map((model) => model.id)).toEqual(["model-a", "model-b"]);
		expect(network).toHaveBeenCalledOnce();
		expect(new Headers(network.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer login-secret");
	});

	it("rejects surrounding whitespace in a selected target", async () => {
		const network = vi.fn<typeof fetch>();
		const controller = createActualyzeProvider({
			fetch: network,
			target: () => " customer ",
		});
		const interaction = keyInteraction("secret");
		const login = controller.provider.auth.apiKey?.login?.(interaction);
		await expect(login).rejects.toBeInstanceOf(ActualyzeConfigurationError);
		await expect(login).rejects.toThrow(/one ASCII DNS label/u);
		// A bad selection fails before the user is asked for a key.
		expect(interaction.prompt).not.toHaveBeenCalled();
		expect(network).not.toHaveBeenCalled();
	});

	it("does not install or return a credential when login validation fails", async () => {
		const controller = createActualyzeProvider({
			fetch: async () => new Response(null, { status: 401 }),
		});
		const answers = ["bad-secret"];
		const interaction = {
			signal: new AbortController().signal,
			prompt: async () => answers.shift() ?? "",
			notify: vi.fn(),
		};
		await expect(controller.provider.auth.apiKey?.login?.(interaction)).rejects.toThrow(/HTTP 401/u);
		expect(controller.getModels()).toEqual([]);
	});
});

describe("Actualyze target selection", () => {
	describe("when resolving ambient auth", () => {
		it.each([
			{ flag: undefined, env: undefined, expected: "app" },
			{ flag: "", env: "", expected: "app" },
			{ flag: "", env: "team", expected: "team" },
			{ flag: "flagged", env: "team", expected: "flagged" },
		])("selects $expected for flag $flag and ACTUALYZE_TARGET $env", async ({ flag, env, expected }) => {
			const { provider } = createActualyzeProvider({ target: () => flag });
			const ctx = authContext({
				ACTUALYZE_TARGET: env,
				ACTUALYZE_API_KEY: "ambient-key",
			});
			const signal = new AbortController().signal;
			await expect(provider.auth.apiKey?.resolve({ ctx, signal })).resolves.toEqual({
				auth: {
					apiKey: "ambient-key",
					baseUrl: `https://${expected}.actualyze.ai/openai/v1`,
				},
				env: { ACTUALYZE_TARGET: expected },
				source: "ACTUALYZE_API_KEY",
			});
			await expect(provider.auth.apiKey?.check?.({ ctx, signal })).resolves.toEqual({
				type: "api_key",
				source: "ACTUALYZE_API_KEY",
			});
		});

		it("reports an invalid selected target as unavailable even when ACTUALYZE_TARGET is valid", async () => {
			const { provider } = createActualyzeProvider({
				target: () => "evil.example",
			});
			const ctx = authContext({
				ACTUALYZE_TARGET: "team",
				ACTUALYZE_API_KEY: "ambient-key",
			});
			const signal = new AbortController().signal;
			await expect(provider.auth.apiKey?.resolve({ ctx, signal })).resolves.toBeUndefined();
			await expect(provider.auth.apiKey?.check?.({ ctx, signal })).resolves.toBeUndefined();
		});

		it("reads the selected target on every resolution, not at construction", async () => {
			let flag: string | undefined;
			const { provider } = createActualyzeProvider({ target: () => flag });
			flag = "late";
			await expect(
				provider.auth.apiKey?.resolve({
					ctx: authContext({ ACTUALYZE_API_KEY: "ambient-key" }),
					signal: new AbortController().signal,
				}),
			).resolves.toMatchObject({ env: { ACTUALYZE_TARGET: "late" } });
		});
	});

	describe("when logging in", () => {
		it("prompts once for the key against production when nothing is selected", async () => {
			vi.stubEnv("ACTUALYZE_TARGET", "");
			const network = vi.fn<typeof fetch>(async () => jsonResponse(catalogPayload));
			const controller = createActualyzeProvider({ fetch: network });
			const interaction = keyInteraction("prod-key");
			await expect(controller.provider.auth.apiKey?.login?.(interaction)).resolves.toEqual(
				credential("app", "prod-key"),
			);
			expect(interaction.prompt).toHaveBeenCalledOnce();
			expect(interaction.prompt).toHaveBeenCalledWith({
				type: "secret",
				message: "Actualyze API key for app.actualyze.ai",
			});
			expect(requestedHost(network.mock.calls[0])).toBe("app.actualyze.ai");
		});

		it("logs in to the selected target over ACTUALYZE_TARGET", async () => {
			vi.stubEnv("ACTUALYZE_TARGET", "team");
			const network = vi.fn<typeof fetch>(async () => jsonResponse(catalogPayload));
			const controller = createActualyzeProvider({
				fetch: network,
				target: () => "Flagged",
			});
			const interaction = keyInteraction("flag-key");
			await expect(controller.provider.auth.apiKey?.login?.(interaction)).resolves.toEqual(
				credential("flagged", "flag-key"),
			);
			expect(interaction.prompt).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Actualyze API key for flagged.actualyze.ai",
				}),
			);
			expect(requestedHost(network.mock.calls[0])).toBe("flagged.actualyze.ai");
		});

		it("rejects an invalid ACTUALYZE_TARGET before prompting", async () => {
			vi.stubEnv("ACTUALYZE_TARGET", "evil.example");
			const network = vi.fn<typeof fetch>();
			const controller = createActualyzeProvider({ fetch: network });
			const interaction = keyInteraction("secret");
			await expect(controller.provider.auth.apiKey?.login?.(interaction)).rejects.toBeInstanceOf(
				ActualyzeConfigurationError,
			);
			expect(interaction.prompt).not.toHaveBeenCalled();
			expect(network).not.toHaveBeenCalled();
		});
	});

	describe("when refreshing models", () => {
		const publishAll = async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		};

		it("restores the production cache for an ACTUALYZE_API_KEY-only environment", async () => {
			vi.stubEnv("ACTUALYZE_API_KEY", "ambient-key");
			const controller = createActualyzeProvider({
				fetch: async () => {
					throw new Error("cache-only refresh must not use the network");
				},
			});
			const [cached] = parseCatalog({ data: [modelEntry("prod-cached")] }, "https://app.actualyze.ai/openai/v1");
			await controller.provider.refreshModels?.(
				refreshContext({
					credential: undefined,
					allowNetwork: false,
					stored: { models: [cached] },
					publish: publishAll,
				}),
			);
			expect(controller.getModels().map((model) => model.id)).toEqual(["prod-cached"]);
		});

		it("fetches from the selected target over ACTUALYZE_TARGET", async () => {
			vi.stubEnv("ACTUALYZE_TARGET", "team");
			vi.stubEnv("ACTUALYZE_API_KEY", "ambient-key");
			const network = vi.fn<typeof fetch>(async () => jsonResponse(catalogPayload));
			const controller = createActualyzeProvider({
				fetch: network,
				target: () => "flagged",
			});
			await controller.provider.refreshModels?.(refreshContext({ credential: undefined, publish: publishAll }));
			expect(requestedHost(network.mock.calls[0])).toBe("flagged.actualyze.ai");
			expect(controller.getModels().map((model) => model.baseUrl)).toEqual([
				"https://flagged.actualyze.ai/openai/v1",
				"https://flagged.actualyze.ai/openai/v1",
			]);
		});

		it("keeps a stored credential's target over the selected target", async () => {
			const network = vi.fn<typeof fetch>(async () => jsonResponse(catalogPayload));
			const controller = createActualyzeProvider({
				fetch: network,
				target: () => "flagged",
			});
			await controller.provider.refreshModels?.(
				refreshContext({
					credential: credential("stored", "stored-key"),
					publish: publishAll,
				}),
			);
			expect(requestedHost(network.mock.calls[0])).toBe("stored.actualyze.ai");
		});
	});
});

describe("dynamic Actualyze catalog lifecycle", () => {
	it("restores only a complete target-matching catalog", async () => {
		const controller = createActualyzeProvider();
		const matching = {
			...modelEntry("cached"),
		};
		const [cachedModel] = parseCatalog({ data: [matching] }, "https://customer.actualyze.ai/openai/v1");
		const publications: ModelsPublication[] = [];
		await controller.provider.refreshModels?.(
			refreshContext({
				allowNetwork: false,
				stored: { models: [cachedModel] },
				publish: async (publication) => {
					publications.push(publication);
					publication.update?.();
					return true;
				},
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["cached"]);
		expect(publications[0]?.persist).toBeUndefined();
	});

	it("deletes a mismatched-target cache without installing it", async () => {
		const controller = createActualyzeProvider();
		const stale = {
			id: "stale",
			name: "stale",
			api: "openai-completions",
			provider: "actualyze",
			baseUrl: "https://old.actualyze.ai/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} satisfies Model<"openai-completions">;
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				allowNetwork: false,
				stored: { models: [stale] },
				publish,
			}),
		);
		expect(controller.getModels()).toEqual([]);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ persist: null }));
	});

	it("deletes a same-target cache that holds a non-chat model entry", async () => {
		const controller = createActualyzeProvider();
		const [chat] = parseCatalog({ data: [modelEntry("chat")] }, "https://customer.actualyze.ai/openai/v1");
		// The image API is an open string, so only the model type tells this
		// entry apart from a restorable chat model.
		const image = {
			type: "image",
			id: "image",
			name: "image",
			api: "openai-completions",
			provider: "actualyze",
			baseUrl: "https://customer.actualyze.ai/openai/v1",
			input: ["text"],
			output: ["image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} satisfies ImageModel<ImageApi>;
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				allowNetwork: false,
				stored: { models: [chat, image] },
				publish,
			}),
		);
		expect(controller.getModels()).toEqual([]);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ persist: null }));
	});

	it("restores a persisted matching-target catalog for ambient-env-only credentials without network", async () => {
		vi.stubEnv("ACTUALYZE_TARGET", "ambient");
		vi.stubEnv("ACTUALYZE_API_KEY", "ambient-key");
		const controller = createActualyzeProvider({
			fetch: async () => {
				throw new Error("cache-only refresh must not use the network");
			},
		});
		const [cached] = parseCatalog({ data: [modelEntry("ambient-cached")] }, "https://ambient.actualyze.ai/openai/v1");
		const publications: ModelsPublication[] = [];
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: undefined,
				allowNetwork: false,
				stored: { models: [cached] },
				publish: async (publication) => {
					publications.push(publication);
					publication.update?.();
					return true;
				},
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["ambient-cached"]);
		expect(publications[0]?.persist).toBeUndefined();
	});

	it("restores the matching cache for a stored target with an ambient key", async () => {
		vi.stubEnv("ACTUALYZE_API_KEY", "ambient-key");
		const controller = createActualyzeProvider({
			fetch: async () => {
				throw new Error("cache-only refresh must not use the network");
			},
		});
		const [cached] = parseCatalog(
			{ data: [modelEntry("stored-target-model")] },
			"https://mixed.actualyze.ai/openai/v1",
		);
		const publications: ModelsPublication[] = [];
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: { type: "api_key", env: { ACTUALYZE_TARGET: "mixed" } },
				allowNetwork: false,
				stored: { models: [cached] },
				publish: async (publication) => {
					publications.push(publication);
					publication.update?.();
					return true;
				},
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["stored-target-model"]);
		expect(publications[0]?.persist).toBeUndefined();
	});

	it("prefers live ambient env over a stale last resolution after credential removal", async () => {
		const network = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			return jsonResponse({
				data: [modelEntry(url.hostname.startsWith("target-b.") ? "b-model" : "a-model")],
			});
		});
		const controller = createActualyzeProvider({ fetch: network });
		// Resolving a stored target-A credential seeds lastResolvedConfiguration at A.
		await controller.provider.auth.apiKey?.resolve({
			ctx: authContext({}),
			credential: credential("target-a", "a-key"),
			signal: new AbortController().signal,
		});
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(refreshContext({ credential: credential("target-a", "a-key"), publish }));
		expect(controller.getModels().map((model) => model.id)).toEqual(["a-model"]);

		// Credential removed; ambient env now points at target B. The stale A
		// resolution must not win: B's baseUrl governs the restore filter and refresh.
		vi.stubEnv("ACTUALYZE_TARGET", "target-b");
		vi.stubEnv("ACTUALYZE_API_KEY", "b-key");
		const [staleA] = parseCatalog({ data: [modelEntry("a-model")] }, "https://target-a.actualyze.ai/openai/v1");
		const publications: ModelsPublication[] = [];
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: undefined,
				stored: { models: [staleA] },
				publish: async (publication) => {
					publications.push(publication);
					publication.update?.();
					return true;
				},
			}),
		);
		expect(publications[0]?.persist).toBeNull();
		expect(controller.getModels().map((model) => model.id)).toEqual(["b-model"]);
		expect(publications.at(-1)?.persist?.models.map((model) => model.id)).toEqual(["b-model"]);
		expect(
			publications
				.at(-1)
				?.persist?.models.every((model) => model.baseUrl === "https://target-b.actualyze.ai/openai/v1"),
		).toBe(true);
	});

	it("does not restore a mismatched-target cache for ambient-env-only credentials", async () => {
		vi.stubEnv("ACTUALYZE_TARGET", "ambient");
		vi.stubEnv("ACTUALYZE_API_KEY", "ambient-key");
		const controller = createActualyzeProvider({
			fetch: async () => {
				throw new Error("cache-only refresh must not use the network");
			},
		});
		const [foreign] = parseCatalog({ data: [modelEntry("foreign")] }, "https://other.actualyze.ai/openai/v1");
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: undefined,
				allowNetwork: false,
				stored: { models: [foreign] },
				publish,
			}),
		);
		expect(controller.getModels()).toEqual([]);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ persist: null }));
	});

	it("persists a fresh same-target login catalog instead of restoring the old key's cache", async () => {
		const controller = createActualyzeProvider({
			fetch: async () => jsonResponse({ data: [modelEntry("fresh-entitlement")] }),
		});
		vi.stubEnv("ACTUALYZE_TARGET", "customer");
		const answers = ["rotated-key"];
		await controller.provider.auth.apiKey?.login?.({
			signal: new AbortController().signal,
			prompt: async () => answers.shift() ?? "",
			notify: vi.fn(),
		});
		const [oldCachedModel] = parseCatalog(
			{ data: [modelEntry("old-entitlement")] },
			"https://customer.actualyze.ai/openai/v1",
		);
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("customer", "rotated-key"),
				allowNetwork: false,
				stored: { models: [oldCachedModel] },
				publish,
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["fresh-entitlement"]);
		expect(publish.mock.calls[0]?.[0].persist?.models.map((model) => model.id)).toEqual(["fresh-entitlement"]);
	});

	it("preserves the login catalog when a superseded stale refresh's publishes fail", async () => {
		const controller = createActualyzeProvider({
			fetch: async () => jsonResponse({ data: [modelEntry("fresh-login-model")] }),
		});
		vi.stubEnv("ACTUALYZE_TARGET", "new-target");
		const answers = ["new-key"];
		await controller.provider.auth.apiKey?.login?.({
			signal: new AbortController().signal,
			prompt: async () => answers.shift() ?? "",
			notify: vi.fn(),
		});
		// pi's post-login refresh supersedes the stale in-flight refresh, so its
		// publishes return false; the pending login catalog must survive them.
		const [oldCachedModel] = parseCatalog(
			{ data: [modelEntry("old-model")] },
			"https://old-target.actualyze.ai/openai/v1",
		);
		const superseded = vi.fn(async (_publication: ModelsPublication) => false);
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("old-target", "old-key"),
				stored: { models: [oldCachedModel] },
				publish: superseded,
			}),
		);
		expect(superseded).toHaveBeenCalled();
		expect(controller.getModels().map((model) => model.id)).toEqual(["fresh-login-model"]);

		// The follow-up refresh carrying the new credential still publishes the
		// pending login catalog.
		const matching = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("new-target", "new-key"),
				allowNetwork: false,
				publish: matching,
			}),
		);
		expect(matching).toHaveBeenCalledOnce();
		expect(matching.mock.calls[0]?.[0].persist?.models.map((model) => model.id)).toEqual(["fresh-login-model"]);
	});

	it("preserves the pending login catalog across a successful mismatched refresh", async () => {
		const network = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			return jsonResponse({
				data: [modelEntry(url.hostname.startsWith("old-target.") ? "old-model" : "fresh-login-model")],
			});
		});
		const controller = createActualyzeProvider({ fetch: network });
		vi.stubEnv("ACTUALYZE_TARGET", "new-target");
		const answers = ["new-key"];
		await controller.provider.auth.apiKey?.login?.({
			signal: new AbortController().signal,
			prompt: async () => answers.shift() ?? "",
			notify: vi.fn(),
		});
		// A mismatched refresh publishes the old target's catalog (restore and
		// network both run) but never consumes the pending login catalog: a
		// successful publish could equally be a stale refresh racing the login.
		const [oldCachedModel] = parseCatalog(
			{ data: [modelEntry("old-model")] },
			"https://old-target.actualyze.ai/openai/v1",
		);
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("old-target", "old-key"),
				stored: { models: [oldCachedModel] },
				publish,
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["old-model"]);
		const refreshedHost = new URL(
			network.mock.calls.at(-1)?.[0] instanceof Request
				? (network.mock.calls.at(-1)?.[0] as Request).url
				: String(network.mock.calls.at(-1)?.[0]),
		).hostname;
		expect(refreshedHost).toBe("old-target.actualyze.ai");

		// Pending survived: a later refresh matching the login credential
		// republishes the login catalog from memory without a network fetch.
		const later = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		network.mockClear();
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("new-target", "new-key"),
				publish: later,
			}),
		);
		expect(network).not.toHaveBeenCalled();
		expect(later.mock.calls[0]?.[0].persist?.models.map((model) => model.id)).toEqual(["fresh-login-model"]);
		expect(controller.getModels().map((model) => model.id)).toEqual(["fresh-login-model"]);
	});

	it("recovers the login catalog when a stale refresh's publish lands before supersession", async () => {
		// Models pi's real ordering: pi does not supersede an in-flight refresh at
		// provider-login time, so a stale old-credential refresh's network publish
		// can still succeed AFTER login completes. The pending login catalog must
		// survive that publish so the post-login sync refresh can restore it.
		let releaseOldFetch: (() => void) | undefined;
		const oldFetchGate = new Promise<void>((resolve) => {
			releaseOldFetch = resolve;
		});
		const network = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname.startsWith("old-target.")) {
				await oldFetchGate;
				return jsonResponse({ data: [modelEntry("old-model")] });
			}
			return jsonResponse({ data: [modelEntry("fresh-login-model")] });
		});
		const controller = createActualyzeProvider({ fetch: network });

		// Stale refresh starts with the old credential; its network fetch stalls.
		let persisted: ModelsPublication["persist"];
		const publish = vi.fn(async (publication: ModelsPublication) => {
			if (publication.persist !== undefined) persisted = publication.persist;
			publication.update?.();
			return true;
		});
		const staleRefresh = controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("old-target", "old-key"),
				publish,
			}),
		);

		// Login completes while the stale refresh is in flight.
		vi.stubEnv("ACTUALYZE_TARGET", "new-target");
		const answers = ["new-key"];
		await controller.provider.auth.apiKey?.login?.({
			signal: new AbortController().signal,
			prompt: async () => answers.shift() ?? "",
			notify: vi.fn(),
		});
		expect(controller.getModels().map((model) => model.id)).toEqual(["fresh-login-model"]);

		// The stale fetch resolves and its publish succeeds (generation still
		// current at publish time, so no supersession happened).
		releaseOldFetch?.();
		await staleRefresh;
		expect(controller.getModels().map((model) => model.id)).toEqual(["old-model"]);

		// Post-login sync refresh: cache-only, new credential, stored = whatever
		// the stale refresh persisted. It must restore the LOGIN catalog.
		const syncPublish = vi.fn(async (publication: ModelsPublication) => {
			if (publication.persist !== undefined) persisted = publication.persist;
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("new-target", "new-key"),
				allowNetwork: false,
				stored: persisted ? { models: persisted.models } : undefined,
				publish: syncPublish,
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["fresh-login-model"]);
		expect(persisted?.models.map((model) => model.id)).toEqual(["fresh-login-model"]);
	});

	it("clears a foreign in-memory catalog on a cache-only mismatched refresh without a stored generation", async () => {
		const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("a-model")] }));
		const controller = createActualyzeProvider({ fetch: network });
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		// Install target A's catalog.
		await controller.provider.refreshModels?.(refreshContext({ credential: credential("target-a", "a-key"), publish }));
		expect(controller.getModels().map((model) => model.id)).toEqual(["a-model"]);

		// Cache-only refresh under target B with no stored generation: the
		// in-memory A catalog must not stay visible under B's auth.
		const cleanup = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("target-b", "b-key"),
				allowNetwork: false,
				publish: cleanup,
			}),
		);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(cleanup.mock.calls[0]?.[0].persist).toBeNull();
		expect(controller.getModels()).toEqual([]);
	});

	it("clears an installed old-target catalog when external configuration changes", async () => {
		const controller = createActualyzeProvider({
			fetch: async () => jsonResponse({ data: [modelEntry("old-model")] }),
		});
		const publish = async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		};
		await controller.provider.refreshModels?.(refreshContext({ credential: credential("old", "old-key"), publish }));
		const [storedOld] = parseCatalog({ data: [modelEntry("old-model")] }, "https://old.actualyze.ai/openai/v1");
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("customer", "new-key"),
				allowNetwork: false,
				stored: { models: [storedOld] },
				publish,
			}),
		);
		expect(controller.getModels()).toEqual([]);
	});

	it("clears an old target and publishes the new target's network generation", async () => {
		const network = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			return jsonResponse({
				data: [modelEntry(url.hostname.startsWith("new.") ? "new-model" : "old-model")],
			});
		});
		const controller = createActualyzeProvider({ fetch: network });
		const publications: ModelsPublication[] = [];
		const publish = async (publication: ModelsPublication) => {
			publications.push(publication);
			publication.update?.();
			return true;
		};
		await controller.provider.refreshModels?.(refreshContext({ credential: credential("old", "old-key"), publish }));
		const [storedOld] = parseCatalog({ data: [modelEntry("old-model")] }, "https://old.actualyze.ai/openai/v1");
		await controller.provider.refreshModels?.(
			refreshContext({
				credential: credential("new", "new-key"),
				stored: { models: [storedOld] },
				publish,
			}),
		);
		expect(controller.getModels().map((model) => model.id)).toEqual(["new-model"]);
		expect(publications.at(-1)?.persist?.models.map((model) => model.id)).toEqual(["new-model"]);
		expect(network).toHaveBeenCalledTimes(2);
	});

	it("atomically publishes a complete network generation", async () => {
		const network = vi.fn<typeof fetch>(async () => jsonResponse(catalogPayload));
		const controller = createActualyzeProvider({ fetch: network });
		const publish = vi.fn(async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		});
		await controller.provider.refreshModels?.(refreshContext({ publish }));
		expect(controller.getModels().map((model) => model.id)).toEqual(["model-a", "model-b"]);
		expect(publish.mock.calls[0]?.[0].persist?.models).toHaveLength(2);
	});

	it("retains the previous generation when a refresh is invalid", async () => {
		const responses = [
			jsonResponse(catalogPayload),
			jsonResponse({
				data: [modelEntry("duplicate"), modelEntry("duplicate")],
			}),
		];
		const controller = createActualyzeProvider({
			fetch: async () => responses.shift() ?? jsonResponse({ data: [] }),
		});
		const publish = async (publication: ModelsPublication) => {
			publication.update?.();
			return true;
		};
		await controller.provider.refreshModels?.(refreshContext({ publish }));
		await expect(controller.provider.refreshModels?.(refreshContext({ publish }))).rejects.toThrow(/duplicate/u);
		expect(controller.getModels().map((model) => model.id)).toEqual(["model-a", "model-b"]);
	});
});
