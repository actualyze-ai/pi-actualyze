import { type ExtensionAPI, parseArgs } from "@earendil-works/pi-coding-agent";
import { ACTUALYZE_DEFAULT_TARGET, ACTUALYZE_TARGET_FLAG } from "./constants.js";
import { createActualyzeProvider } from "./provider.js";

export { ACTUALYZE_PROVIDER_ID } from "./constants.js";
export {
	type ActualyzeProviderController,
	type ActualyzeProviderOptions,
	createActualyzeProvider,
} from "./provider.js";

/**
 * pi applies extension flag values only after its startup cache-only model
 * refresh, so getFlag() is still undefined during that refresh. Without this
 * fallback, `--actualyze-target` with an ambient ACTUALYZE_API_KEY would
 * resolve production at startup and discard the selected target's cached
 * catalog. pi's own parser keeps the argv interpretation identical to pi's.
 */
function commandLineTarget(): string | undefined {
	// Assumes pi's CLI owns process.argv. SDK hosts that pass flags through
	// extensionFlagValues are not seen here; they should use ACTUALYZE_TARGET
	// or createActualyzeProvider({ target }) instead.
	const value = parseArgs(process.argv.slice(2)).unknownFlags.get(ACTUALYZE_TARGET_FLAG);
	return typeof value === "string" ? value : undefined;
}

export default function actualyzeExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ACTUALYZE_TARGET_FLAG, {
		description: `Actualyze target label for non-production environments (default: ${ACTUALYZE_DEFAULT_TARGET})`,
		type: "string",
	});
	let argvTarget: { value: string | undefined } | undefined;
	pi.registerProvider(
		createActualyzeProvider({
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
				argvTarget ??= { value: commandLineTarget() };
				return argvTarget.value;
			},
		}).provider,
	);
}
