import type {
	Api,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { ActualyzeClient, type ActualyzeClientOptions } from "./client.js";
import {
	ACTUALYZE_API_KEY_ENV,
	ACTUALYZE_PROVIDER_ID,
	ACTUALYZE_PROVIDER_NAME,
	ACTUALYZE_TARGET_ENV,
} from "./constants.js";
import { ActualyzeConfigurationError, actualyzeBaseUrl, normalizeTarget, validateApiKey } from "./endpoint.js";
import { createGuardedFetch } from "./transport.js";

interface ResolvedConfiguration {
	target: string;
	apiKey: string;
	baseUrl: string;
	source: string;
}

interface PendingLoginCatalog {
	configuration: ResolvedConfiguration;
	models: readonly Model<"openai-completions">[];
}

export interface ActualyzeProviderOptions extends ActualyzeClientOptions {}

export interface ActualyzeProviderController {
	provider: Provider<"openai-completions">;
	getModels(): readonly Model<"openai-completions">[];
}

function credentialValue(credential: ApiKeyCredential | undefined, name: string): string | undefined {
	const value = credential?.env?.[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function resolveConfiguration(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<ResolvedConfiguration | undefined> {
	const storedTarget = credentialValue(credential, ACTUALYZE_TARGET_ENV);
	const rawTarget = storedTarget ?? (await ctx.env(ACTUALYZE_TARGET_ENV));
	const storedKey = credential?.key;
	const rawKey = storedKey ?? (await ctx.env(ACTUALYZE_API_KEY_ENV));
	if (!rawTarget || !rawKey) return undefined;
	let target: string;
	try {
		target = normalizeTarget(rawTarget);
	} catch (error) {
		// Corruption in a stored field must surface; invalid ambient env is
		// treated as unavailable authentication.
		if (storedTarget) throw error;
		return undefined;
	}
	let apiKey: string;
	try {
		apiKey = validateApiKey(rawKey);
	} catch (error) {
		if (storedKey) throw error;
		return undefined;
	}
	return {
		target,
		apiKey,
		baseUrl: actualyzeBaseUrl(target),
		source: storedTarget || storedKey ? "stored credential" : `${ACTUALYZE_TARGET_ENV} and ${ACTUALYZE_API_KEY_ENV}`,
	};
}

function isRestorableModel(model: Model<Api>, baseUrl: string): model is Model<"openai-completions"> {
	return model.provider === ACTUALYZE_PROVIDER_ID && model.api === "openai-completions" && model.baseUrl === baseUrl;
}

function refreshConfiguration(credential: ApiKeyCredential | undefined): ResolvedConfiguration | undefined {
	// Field-by-field precedence, mirroring resolveConfiguration: each stored
	// field wins over its ambient counterpart independently. refreshModels has
	// no AuthContext, so ambient values come from process.env (the login prompt
	// reads process.env directly for the same reason). Validation here is
	// non-throwing: corrupt stored fields still surface via resolve() throwing
	// in pi's phase-2 network refresh, so the lastResolvedConfiguration
	// fallback in the caller only affects cache-only restore.
	const storedTarget = credentialValue(credential, ACTUALYZE_TARGET_ENV);
	const rawTarget = storedTarget ?? process.env[ACTUALYZE_TARGET_ENV];
	const storedKey = credential?.key;
	const rawKey = storedKey ?? process.env[ACTUALYZE_API_KEY_ENV];
	if (!rawTarget || !rawKey) return undefined;
	try {
		const target = normalizeTarget(rawTarget);
		return {
			target,
			apiKey: validateApiKey(rawKey),
			baseUrl: actualyzeBaseUrl(target),
			source: storedTarget || storedKey ? "stored credential" : `${ACTUALYZE_TARGET_ENV} and ${ACTUALYZE_API_KEY_ENV}`,
		};
	} catch {
		return undefined;
	}
}

function streamBaseUrl(env: Record<string, string> | undefined): string {
	const target = env?.[ACTUALYZE_TARGET_ENV];
	if (!target) throw new Error("Actualyze request is missing its resolved target configuration");
	return actualyzeBaseUrl(target);
}

export function createActualyzeProvider(options: ActualyzeProviderOptions = {}): ActualyzeProviderController {
	let models: readonly Model<"openai-completions">[] = [];
	let lastResolvedConfiguration: ResolvedConfiguration | undefined;
	let pendingLoginCatalog: PendingLoginCatalog | undefined;
	const streams = openAICompletionsApi();
	const underlyingFetch = options.fetch ?? globalThis.fetch;

	const installCatalog = (catalog: readonly Model<"openai-completions">[]): void => {
		models = catalog;
	};

	const assertModelOnActiveTarget = (model: Model<"openai-completions">, activeBaseUrl: string): void => {
		const catalogEntry = models.find((entry) => entry.id === model.id);
		if (model.baseUrl !== activeBaseUrl || (catalogEntry && catalogEntry.baseUrl !== activeBaseUrl)) {
			throw new Error("Refusing Actualyze request for a model from another target");
		}
		if (models.length > 0 && !catalogEntry) {
			// The id is remote-origin (it came through parseCatalog at some point),
			// but validateModelId already rejected control/bidi characters and
			// bounded its length, and JSON.stringify escapes what remains —
			// unlike the catalog parser context, this id has passed validation.
			throw new Error(
				`Refusing Actualyze request for ${JSON.stringify(model.id)}: it is not in the discovered catalog for the active target`,
			);
		}
	};

	const provider: Provider<"openai-completions"> = {
		id: ACTUALYZE_PROVIDER_ID,
		name: ACTUALYZE_PROVIDER_NAME,
		auth: {
			apiKey: {
				name: "Actualyze API key",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredTarget = await interaction.prompt({
						type: "text",
						message: "Actualyze target",
						placeholder: process.env[ACTUALYZE_TARGET_ENV] ?? "customer",
					});
					const target = normalizeTarget(
						enteredTarget === "" ? process.env[ACTUALYZE_TARGET_ENV] || "" : enteredTarget,
					);
					const enteredKey = await interaction.prompt({
						type: "secret",
						message: "Actualyze API key",
					});
					const apiKey = validateApiKey(enteredKey);
					const baseUrl = actualyzeBaseUrl(target);
					const catalog = await new ActualyzeClient(baseUrl, apiKey, options).list(interaction.signal);
					const configuration = {
						target,
						apiKey,
						baseUrl,
						source: "stored credential",
					};
					installCatalog(catalog);
					lastResolvedConfiguration = configuration;
					pendingLoginCatalog = { configuration, models: catalog };
					return {
						type: "api_key",
						key: apiKey,
						env: { [ACTUALYZE_TARGET_ENV]: target },
					};
				},
				check: async ({ ctx, credential }) => {
					let configuration: ResolvedConfiguration | undefined;
					try {
						configuration = await resolveConfiguration(ctx, credential);
					} catch (error) {
						if (error instanceof ActualyzeConfigurationError) return undefined;
						throw error;
					}
					if (!configuration) return undefined;
					lastResolvedConfiguration = configuration;
					return { type: "api_key", source: configuration.source };
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const configuration = await resolveConfiguration(ctx, credential);
					if (!configuration) return undefined;
					lastResolvedConfiguration = configuration;
					return {
						auth: {
							apiKey: configuration.apiKey,
							baseUrl: configuration.baseUrl,
						},
						env: { [ACTUALYZE_TARGET_ENV]: configuration.target },
						source: configuration.source,
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const credential = context.credential?.type === "api_key" ? context.credential : undefined;
			const configuration = refreshConfiguration(credential) ?? lastResolvedConfiguration;
			if (!configuration) return;

			if (
				pendingLoginCatalog &&
				pendingLoginCatalog.configuration.baseUrl === configuration.baseUrl &&
				pendingLoginCatalog.configuration.apiKey === configuration.apiKey
			) {
				const pending = pendingLoginCatalog;
				const published = await context.publish({
					persist: { models: pending.models, checkedAt: Date.now() },
					update: () => installCatalog(pending.models),
				});
				if (published) pendingLoginCatalog = undefined;
				return;
			}

			// A mismatched pending login catalog is NEVER cleared here; only the
			// matching branch above consumes it. Rationale: a stale old-credential
			// refresh can race a fresh login without being superseded until the
			// runtime's post-login sync, so even a *successful* mismatched publish
			// may be the stale refresh clobbering the login. Leaving pending in
			// place makes the race self-heal — the post-login refresh matches
			// pending and republishes the login catalog. Tradeoff: if auth
			// genuinely moves to another target, pending is retained as dead
			// weight (one catalog array), and should auth later return to the
			// pending configuration without a new login, the matching branch
			// republishes the login-time catalog once (bounded staleness) before
			// the next refresh fetches fresh. This also avoids relying on any
			// host-specific supersession behavior: publish-gating alone suffices.

			if (context.stored) {
				const restored = context.stored.models.filter((model) => isRestorableModel(model, configuration.baseUrl));
				if (restored.length === context.stored.models.length) {
					if (!(await context.publish({ update: () => installCatalog(restored) }))) return;
				} else if (
					!(await context.publish({
						persist: null,
						update: () => {
							if (!models.every((model) => isRestorableModel(model, configuration.baseUrl))) installCatalog([]);
						},
					}))
				) {
					return;
				}
			} else if (models.length > 0 && !models.every((model) => isRestorableModel(model, configuration.baseUrl))) {
				// No stored generation, but the in-memory catalog belongs to another
				// target: clear it so the picker does not show unusable models under
				// the new auth (persist: null on an absent generation is a no-op
				// delete).
				if (
					!(await context.publish({
						persist: null,
						update: () => {
							if (!models.every((model) => isRestorableModel(model, configuration.baseUrl))) installCatalog([]);
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			const catalog = await new ActualyzeClient(configuration.baseUrl, configuration.apiKey, options).list(
				context.signal,
			);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: catalog, checkedAt: Date.now() },
				update: () => installCatalog(catalog),
			});
		},
		stream: (model, context, streamOptions) => {
			const activeBaseUrl = streamBaseUrl(streamOptions?.env);
			assertModelOnActiveTarget(model, activeBaseUrl);
			return streams.stream(model, context, {
				...streamOptions,
				fetch: createGuardedFetch(activeBaseUrl, underlyingFetch),
			});
		},
		streamSimple: (model, context, streamOptions) => {
			const activeBaseUrl = streamBaseUrl(streamOptions?.env);
			assertModelOnActiveTarget(model, activeBaseUrl);
			return streams.streamSimple(model, context, {
				...streamOptions,
				fetch: createGuardedFetch(activeBaseUrl, underlyingFetch),
			});
		},
	};

	return { provider, getModels: () => models };
}
