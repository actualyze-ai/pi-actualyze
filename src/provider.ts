import {
	type AnyModel,
	type ApiKeyCredential,
	type AuthContext,
	type AuthResult,
	isModelType,
	type Model,
	type Provider,
	type ProviderHeaders,
	type RefreshModelsContext,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { ActualyzeClient, type ActualyzeClientOptions } from "./client.js";
import {
	ACTUALYZE_API_KEY_ENV,
	ACTUALYZE_DEFAULT_TARGET,
	ACTUALYZE_NO_TARGET,
	ACTUALYZE_OPENAI_BASE_URL_ENV,
	ACTUALYZE_PROVIDER_ID,
	ACTUALYZE_PROVIDER_NAME,
	ACTUALYZE_REQUEST_METADATA_HEADER,
	ACTUALYZE_TARGET_ENV,
} from "./constants.js";
import {
	ActualyzeConfigurationError,
	actualyzeBaseUrl,
	endpointLabel,
	normalizeBaseUrl,
	normalizeTarget,
	validateApiKey,
} from "./endpoint.js";
import { createGuardedFetch } from "./transport.js";

/**
 * Where a key may be sent: the base URL, and the provider env that names it.
 * pi stores the env with a login credential and hands the resolved env back
 * to `stream()`, so it holds exactly one of `ACTUALYZE_TARGET` and
 * `ACTUALYZE_OPENAI_BASE_URL`.
 */
interface Endpoint {
	baseUrl: string;
	env: Record<string, string>;
}

interface ResolvedConfiguration extends Endpoint {
	apiKey: string;
	source: string;
}

/** The environment values that apply where no stored credential field does. */
interface AmbientValues {
	target: string | undefined;
	baseUrl: string | undefined;
	apiKey: string | undefined;
}

interface PendingCatalog {
	configuration: ResolvedConfiguration;
	models: readonly Model<"openai-completions">[];
}

export interface ActualyzeProviderOptions extends ActualyzeClientOptions {
	/**
	 * Explicit target selection, such as the `--actualyze-target` CLI flag.
	 * Read lazily on every resolution because pi parses extension flags after
	 * the extension factory runs. Takes precedence over `ACTUALYZE_TARGET`;
	 * a stored credential's endpoint still wins over both.
	 */
	target?: () => string | undefined;
}

export interface PrimeCatalogOptions {
	/** The model id the command line names. */
	modelId?: string;
	/** The models pi has cached for this provider. */
	cached?: readonly AnyModel[];
	signal?: AbortSignal;
}

export interface ActualyzeProviderController {
	provider: Provider<"openai-completions">;
	getModels(): readonly Model<"openai-completions">[];
	/**
	 * Fetch the catalog with the configuration the environment alone names
	 * (no stored credential), install it, and stage it so the next refresh
	 * that resolves the same key and endpoint persists it, as login does.
	 * Resolves false without a request when the environment names no key or
	 * no endpoint, or when `cached` is a catalog pi will restore for that
	 * endpoint and it lists `modelId`.
	 */
	primeCatalog(options?: PrimeCatalogOptions): Promise<boolean>;
}

function credentialValue(credential: ApiKeyCredential | undefined, name: string): string | undefined {
	const value = credential?.env?.[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function targetEndpoint(target: string): Endpoint {
	const label = normalizeTarget(target);
	return { baseUrl: actualyzeBaseUrl(label), env: { [ACTUALYZE_TARGET_ENV]: label } };
}

/**
 * The endpoint a target and a base URL name. A target label names
 * `https://<label>.actualyze.ai/openai/v1`; `-` and empty values name
 * nothing. When both name an endpoint they must be the same one: a launcher
 * sets the base URL of the environment its key belongs to, and a target
 * naming another endpoint would send that key elsewhere. Throws
 * ActualyzeConfigurationError for an invalid value or a disagreement.
 */
function endpointFrom(target: string | undefined, baseUrl: string | undefined): Endpoint | undefined {
	const labelled = target && target !== ACTUALYZE_NO_TARGET ? targetEndpoint(target) : undefined;
	if (!baseUrl) return labelled;
	const explicit = normalizeBaseUrl(baseUrl);
	if (labelled && labelled.baseUrl !== explicit) {
		throw new ActualyzeConfigurationError(
			`The Actualyze target and ${ACTUALYZE_OPENAI_BASE_URL_ENV} name different endpoints`,
		);
	}
	return labelled ?? { baseUrl: explicit, env: { [ACTUALYZE_OPENAI_BASE_URL_ENV]: explicit } };
}

/**
 * Field-by-field precedence: a stored key wins over `ACTUALYZE_API_KEY`, and a
 * stored endpoint wins over the ambient one, which the selected target (the
 * CLI flag) or `ACTUALYZE_TARGET` names together with
 * `ACTUALYZE_OPENAI_BASE_URL`. Nothing defaults to production here: without a
 * stored or ambient endpoint there is no configuration, so a key never goes
 * to an endpoint that only a default chose. Corruption in a stored field
 * throws; invalid or contradictory ambient values make authentication
 * unavailable.
 */
function configurationFrom(
	credential: ApiKeyCredential | undefined,
	selectedTarget: string | undefined,
	ambient: AmbientValues,
): ResolvedConfiguration | undefined {
	const storedKey = credential?.key;
	const rawKey = storedKey ?? ambient.apiKey;
	if (!rawKey) return undefined;
	const stored = endpointFrom(
		credentialValue(credential, ACTUALYZE_TARGET_ENV),
		credentialValue(credential, ACTUALYZE_OPENAI_BASE_URL_ENV),
	);
	let endpoint = stored;
	if (!endpoint) {
		try {
			// Empty values count as unset, so `ACTUALYZE_TARGET=` falls through.
			endpoint = endpointFrom(selectedTarget || ambient.target, ambient.baseUrl);
		} catch (error) {
			if (error instanceof ActualyzeConfigurationError) return undefined;
			throw error;
		}
	}
	if (!endpoint) return undefined;
	let apiKey: string;
	try {
		apiKey = validateApiKey(rawKey);
	} catch (error) {
		if (storedKey) throw error;
		return undefined;
	}
	return {
		...endpoint,
		apiKey,
		source: stored || storedKey ? "stored credential" : ACTUALYZE_API_KEY_ENV,
	};
}

async function contextAmbient(ctx: AuthContext): Promise<AmbientValues> {
	return {
		target: await ctx.env(ACTUALYZE_TARGET_ENV),
		baseUrl: await ctx.env(ACTUALYZE_OPENAI_BASE_URL_ENV),
		apiKey: await ctx.env(ACTUALYZE_API_KEY_ENV),
	};
}

function processAmbient(): AmbientValues {
	return {
		target: process.env[ACTUALYZE_TARGET_ENV],
		baseUrl: process.env[ACTUALYZE_OPENAI_BASE_URL_ENV],
		apiKey: process.env[ACTUALYZE_API_KEY_ENV],
	};
}

function isRestorableModel(model: AnyModel, baseUrl: string): model is Model<"openai-completions"> {
	return (
		isModelType(model, "chat") &&
		model.provider === ACTUALYZE_PROVIDER_ID &&
		model.api === "openai-completions" &&
		model.baseUrl === baseUrl
	);
}

function refreshConfiguration(
	credential: ApiKeyCredential | undefined,
	selectedTarget: string | undefined,
): ResolvedConfiguration | undefined {
	// refreshModels has no AuthContext, so ambient values come from
	// process.env (login reads process.env directly for the same reason).
	// Validation here is non-throwing: corrupt stored fields still surface via
	// resolve() throwing in pi's phase-2 network refresh, so the
	// lastResolvedConfiguration fallback in the caller only affects
	// cache-only restore.
	try {
		return configurationFrom(credential, selectedTarget, processAmbient());
	} catch {
		return undefined;
	}
}

/**
 * Login's endpoint: the one the selected target, `ACTUALYZE_TARGET`, and
 * `ACTUALYZE_OPENAI_BASE_URL` name, else production. The key prompt names the
 * host, so the member confirms production by entering a key for it. A `-`
 * target without a base URL selects no endpoint, and login refuses it rather
 * than choose production.
 */
function loginEndpoint(selectedTarget: string | undefined): Endpoint {
	const target = selectedTarget || process.env[ACTUALYZE_TARGET_ENV];
	const endpoint = endpointFrom(target, process.env[ACTUALYZE_OPENAI_BASE_URL_ENV]);
	if (endpoint) return endpoint;
	if (target === ACTUALYZE_NO_TARGET) {
		throw new ActualyzeConfigurationError(
			`The Actualyze target "-" selects no endpoint; set ${ACTUALYZE_OPENAI_BASE_URL_ENV} or a target label to log in`,
		);
	}
	return targetEndpoint(ACTUALYZE_DEFAULT_TARGET);
}

/**
 * Actualyze accepts request-metadata values of up to 256 characters drawn from
 * letters, digits, spaces and `-:_@$#=/+,.`, and rejects the whole request when
 * the header breaks these rules.
 */
const REQUEST_METADATA_VALUE = /^[-a-zA-Z0-9 :_@$#=/+,.]{1,256}$/u;

function hasHeader(headers: ProviderHeaders | Record<string, string> | undefined, name: string): boolean {
	const wanted = name.toLowerCase();
	return headers !== undefined && Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Names pi as the calling agent and the pi session as the run, so Actualyze
 * groups a session's requests together. A header the user configured on the
 * model or the request is kept as is. A session id Actualyze would reject is
 * left out rather than failing the request.
 */
function withRequestMetadata(
	model: Model<"openai-completions">,
	streamOptions: StreamOptions | undefined,
): ProviderHeaders | undefined {
	const headers = streamOptions?.headers;
	if (
		hasHeader(model.headers, ACTUALYZE_REQUEST_METADATA_HEADER) ||
		hasHeader(headers, ACTUALYZE_REQUEST_METADATA_HEADER)
	) {
		return headers;
	}
	const metadata: Record<string, string> = { agent: "pi" };
	const sessionId = streamOptions?.sessionId;
	if (sessionId !== undefined && REQUEST_METADATA_VALUE.test(sessionId)) metadata.run_id = sessionId;
	return {
		...headers,
		[ACTUALYZE_REQUEST_METADATA_HEADER]: JSON.stringify(metadata),
	};
}

function streamBaseUrl(env: Record<string, string> | undefined): string {
	const endpoint = endpointFrom(env?.[ACTUALYZE_TARGET_ENV], env?.[ACTUALYZE_OPENAI_BASE_URL_ENV]);
	if (!endpoint) throw new Error("Actualyze request is missing its resolved endpoint configuration");
	return endpoint.baseUrl;
}

export function createActualyzeProvider(options: ActualyzeProviderOptions = {}): ActualyzeProviderController {
	let models: readonly Model<"openai-completions">[] = [];
	let lastResolvedConfiguration: ResolvedConfiguration | undefined;
	let pendingCatalog: PendingCatalog | undefined;
	const streams = openAICompletionsApi();
	const underlyingFetch = options.fetch ?? globalThis.fetch;
	const selectedTarget = (): string | undefined => options.target?.();

	const installCatalog = (catalog: readonly Model<"openai-completions">[]): void => {
		models = catalog;
	};

	const assertModelOnActiveTarget = (model: Model<"openai-completions">, activeBaseUrl: string): void => {
		const catalogEntry = models.find((entry) => entry.id === model.id);
		if (model.baseUrl !== activeBaseUrl || (catalogEntry && catalogEntry.baseUrl !== activeBaseUrl)) {
			throw new Error("Refusing Actualyze request for a model from another target");
		}
		if (models.length > 0 && !catalogEntry) {
			// The id came from the catalog, so validateModelId has already
			// rejected control and bidi characters and bounded its length;
			// JSON.stringify escapes the rest for the error message.
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
					// Login does not prompt for an endpoint. Resolve it first so an
					// invalid selection fails before the key prompt.
					const endpoint = loginEndpoint(selectedTarget());
					const enteredKey = await interaction.prompt({
						type: "secret",
						message: `Actualyze API key for ${endpointLabel(endpoint.baseUrl)}`,
					});
					const apiKey = validateApiKey(enteredKey);
					const catalog = await new ActualyzeClient(endpoint.baseUrl, apiKey, options).list(interaction.signal);
					const configuration = { ...endpoint, apiKey, source: "stored credential" };
					installCatalog(catalog);
					lastResolvedConfiguration = configuration;
					pendingCatalog = { configuration, models: catalog };
					return {
						type: "api_key",
						key: apiKey,
						env: endpoint.env,
					};
				},
				check: async ({ ctx, credential }) => {
					let configuration: ResolvedConfiguration | undefined;
					try {
						configuration = configurationFrom(credential, selectedTarget(), await contextAmbient(ctx));
					} catch (error) {
						if (error instanceof ActualyzeConfigurationError) return undefined;
						throw error;
					}
					if (!configuration) return undefined;
					lastResolvedConfiguration = configuration;
					return { type: "api_key", source: configuration.source };
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const configuration = configurationFrom(credential, selectedTarget(), await contextAmbient(ctx));
					if (!configuration) return undefined;
					lastResolvedConfiguration = configuration;
					return {
						auth: {
							apiKey: configuration.apiKey,
							baseUrl: configuration.baseUrl,
						},
						env: configuration.env,
						source: configuration.source,
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const credential = context.credential?.type === "api_key" ? context.credential : undefined;
			const configuration = refreshConfiguration(credential, selectedTarget()) ?? lastResolvedConfiguration;
			if (!configuration) return;

			if (
				pendingCatalog &&
				pendingCatalog.configuration.baseUrl === configuration.baseUrl &&
				pendingCatalog.configuration.apiKey === configuration.apiKey
			) {
				const pending = pendingCatalog;
				const published = await context.publish({
					persist: { models: pending.models, checkedAt: Date.now() },
					update: () => installCatalog(pending.models),
				});
				if (published) pendingCatalog = undefined;
				return;
			}

			// Only the matching branch above consumes a pending catalog. A
			// refresh holding an older credential can still be in flight when
			// login completes, and pi does not supersede it until the post-login
			// sync, so a successful mismatched publish may be that stale refresh.
			// Keeping the pending catalog lets the post-login refresh republish
			// it. If auth later returns to the pending configuration without a
			// new login, the staged catalog is republished once before the next
			// network refresh replaces it.

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
				headers: withRequestMetadata(model, streamOptions),
				fetch: createGuardedFetch(activeBaseUrl, underlyingFetch),
			});
		},
		streamSimple: (model, context, streamOptions) => {
			const activeBaseUrl = streamBaseUrl(streamOptions?.env);
			assertModelOnActiveTarget(model, activeBaseUrl);
			return streams.streamSimple(model, context, {
				...streamOptions,
				headers: withRequestMetadata(model, streamOptions),
				fetch: createGuardedFetch(activeBaseUrl, underlyingFetch),
			});
		},
	};

	const primeCatalog = async ({ modelId, cached, signal }: PrimeCatalogOptions = {}): Promise<boolean> => {
		// Called before pi resolves auth, with no access to its credential
		// store, so only the environment can name the key and the endpoint.
		const configuration = refreshConfiguration(undefined, selectedTarget());
		if (!configuration) return false;
		// pi's startup refresh restores a cached catalog only when every entry
		// belongs to this endpoint (see refreshModels), and then it resolves
		// the model from the cache without this fetch.
		if (
			modelId !== undefined &&
			cached !== undefined &&
			cached.length > 0 &&
			cached.every((model) => isRestorableModel(model, configuration.baseUrl)) &&
			cached.some((model) => model.id === modelId)
		) {
			return false;
		}
		const catalog = await new ActualyzeClient(configuration.baseUrl, configuration.apiKey, options).list(signal);
		installCatalog(catalog);
		pendingCatalog = { configuration, models: catalog };
		return true;
	};

	return { provider, getModels: () => models, primeCatalog };
}
