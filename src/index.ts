import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActualyzeProvider } from "./provider.js";

export { ACTUALYZE_PROVIDER_ID } from "./constants.js";
export {
	type ActualyzeProviderController,
	type ActualyzeProviderOptions,
	createActualyzeProvider,
} from "./provider.js";

export default function actualyzeExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createActualyzeProvider().provider);
}
