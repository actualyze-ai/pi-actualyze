import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyModel, ApiKeyCredential } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, parseArgs, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
	ACTUALYZE_NO_TARGET,
	ACTUALYZE_PROVIDER_ID,
	ACTUALYZE_TARGET_FLAG,
	STARTUP_CATALOG_BUDGET_MS,
} from "./constants.js";
import { createActualyzeProvider } from "./provider.js";

export { ACTUALYZE_PROVIDER_ID } from "./constants.js";
export {
	type ActualyzeProviderController,
	type ActualyzeProviderOptions,
	createActualyzeProvider,
	type PrimeCatalogOptions,
} from "./provider.js";

interface CommandLine {
	/** The `--actualyze-target` value. */
	target: string | undefined;
	/**
	 * The model id that `--provider actualyze --model <id>` or
	 * `--model actualyze/<id>` names, when the command line names one.
	 */
	model: string | undefined;
}

/**
 * The parts of pi's command line this extension reads, parsed with pi's own
 * parser so the interpretation is identical to pi's.
 */
function readCommandLine(): CommandLine {
	// Assumes pi's CLI owns process.argv. SDK hosts that pass flags through
	// extensionFlagValues are not seen here; they should use ACTUALYZE_TARGET
	// or createActualyzeProvider({ target }) instead.
	const parsed = parseArgs(process.argv.slice(2));
	const target = parsed.unknownFlags.get(ACTUALYZE_TARGET_FLAG);
	const provider = parsed.provider?.toLowerCase();
	const prefix = `${ACTUALYZE_PROVIDER_ID}/`;
	let model: string | undefined;
	if (parsed.model !== undefined && provider === ACTUALYZE_PROVIDER_ID) {
		model = parsed.model;
	} else if (parsed.model?.toLowerCase().startsWith(prefix) && provider === undefined) {
		model = parsed.model.slice(prefix.length);
	}
	return { target: typeof target === "string" ? target : undefined, model };
}

/**
 * The Actualyze models pi's CLI has cached, read from the models store in its
 * agent dir. pi exports no reader for that store, so anything unreadable
 * counts as no cache, which costs only the fetch a cache would have saved.
 */
function cachedModels(): readonly AnyModel[] | undefined {
	try {
		const content = readFileSync(join(getAgentDir(), "models-store.json"), "utf8").replace(/^\uFEFF/u, "");
		const stored = JSON.parse(content) as Record<string, { models?: unknown } | undefined>;
		const models = stored[ACTUALYZE_PROVIDER_ID]?.models;
		if (!Array.isArray(models) || !models.every((model) => typeof model === "object" && model !== null)) {
			return undefined;
		}
		return models as AnyModel[];
	} catch {
		return undefined;
	}
}

/**
 * The Actualyze API key that pi's CLI has stored in auth.json in its agent
 * dir, read with pi's own reader, which leaves the key as written. When pi
 * reads it, a key that starts with `!` runs as a shell command and `$NAME`
 * expands from the environment. This extension does neither, so only a key
 * that pi uses as written counts; anything else counts as no credential.
 */
function storedCredential(): ApiKeyCredential | undefined {
	const stored: unknown = readStoredCredential(ACTUALYZE_PROVIDER_ID);
	if (typeof stored !== "object" || stored === null) return undefined;
	const { type, key, env } = stored as Record<string, unknown>;
	if (type !== "api_key" || typeof key !== "string" || key.startsWith("!") || key.includes("$")) {
		return undefined;
	}
	if (env === undefined) return { type, key };
	if (typeof env !== "object" || env === null || Array.isArray(env)) return undefined;
	const values = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return { type, key, env: Object.fromEntries(values) };
}

export default async function actualyzeExtension(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag(ACTUALYZE_TARGET_FLAG, {
		// pi reads a separate `-` value as another option, so the help shows the `=` form.
		description: `Actualyze target label, such as app for production (--${ACTUALYZE_TARGET_FLAG}=${ACTUALYZE_NO_TARGET} selects none)`,
		type: "string",
	});
	let commandLine: CommandLine | undefined;
	const argv = (): CommandLine => {
		commandLine ??= readCommandLine();
		return commandLine;
	};
	const controller = createActualyzeProvider({
		target: () => {
			let value: boolean | string | undefined;
			try {
				value = pi.getFlag(ACTUALYZE_TARGET_FLAG);
			} catch {
				// getFlag throws once this extension runtime is stale (after
				// /reload). The old provider can stay registered, and check()
				// must never throw, so fall back to argv, which cannot change.
				value = undefined;
			}
			if (typeof value === "string") return value;
			// pi applies extension flag values only after its startup cache-only
			// model refresh, so getFlag() is still undefined during that refresh.
			// Without the argv value, `--actualyze-target` with an ambient
			// ACTUALYZE_API_KEY would resolve no endpoint at startup and restore
			// none of the selected target's cached catalog.
			return argv().target;
		},
	});
	// pi chooses the session's model from the models it holds after its
	// cache-only startup refresh, before any network refresh, and does not
	// choose again once the network refresh lands. With nothing cached, this
	// provider has no models then: a run that names this provider's model
	// exits with an unknown provider, and a plain start on a stored key opens
	// with another provider's model or none. The factory is the last extension
	// code pi awaits before that choice, so a run that names this provider's
	// model, or one where pi stores an Actualyze key, fetches the catalog here,
	// unless pi's cache already holds the endpoint's catalog, listing the
	// named model if there is one. A pattern pi matches fuzzily or with a
	// thinking suffix is not an exact id, so it still fetches. ModelRuntime
	// treats any PI_OFFLINE value as offline.
	const model = argv().model;
	const credential = storedCredential();
	if ((model !== undefined || credential !== undefined) && process.env.PI_OFFLINE === undefined) {
		try {
			await controller.primeCatalog({
				modelId: model,
				cached: cachedModels(),
				credential,
				// Without a named model a failed fetch leaves pi where it would
				// have started anyway, so an endpoint that does not answer holds
				// up the start only briefly.
				signal: model === undefined ? AbortSignal.timeout(STARTUP_CATALOG_BUDGET_MS) : undefined,
			});
		} catch {
			// A failed fetch must not stop the extension from loading. The
			// catalog stays empty until pi's startup refresh restores a cached
			// one; without a cache, pi reports a named model's provider as
			// unknown and otherwise chooses among its other providers.
		}
	}
	pi.registerProvider(controller.provider);
}
