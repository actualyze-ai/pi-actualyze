import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { ACTUALYZE_PROVIDER_ID, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MAX_MODEL_ID_LENGTH } from "./constants.js";

function isUnsafeModelIdCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

function hasUnsafeModelIdCharacters(value: string): boolean {
	return Array.from(value).some(isUnsafeModelIdCharacter);
}

export const ACTUALYZE_COMPAT = Object.freeze({
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	supportsStrictMode: false,
	maxTokensField: "max_completion_tokens",
} satisfies OpenAICompletionsCompat);

export class ActualyzeCatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActualyzeCatalogError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validateModelId(value: unknown, index: number): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ActualyzeCatalogError(`Model entry ${index} must have a non-empty string id`);
	}
	if (value.length > MAX_MODEL_ID_LENGTH) {
		throw new ActualyzeCatalogError(`Model id at entry ${index} exceeds ${MAX_MODEL_ID_LENGTH} characters`);
	}
	if (value === "." || value === "..") {
		throw new ActualyzeCatalogError(`Model entry ${index} has an unsafe dot-segment id`);
	}
	if (hasUnsafeModelIdCharacters(value)) {
		throw new ActualyzeCatalogError(`Model entry ${index} has control characters in its id`);
	}
	try {
		encodeURIComponent(value);
	} catch {
		throw new ActualyzeCatalogError(`Model entry ${index} has an id that cannot be URL-encoded`);
	}
	return value;
}

function advertisedImageInput(entry: Record<string, unknown>): boolean {
	const modalities = entry.modalities;
	if (!isRecord(modalities) || !Array.isArray(modalities.input)) return false;
	return modalities.input.includes("image");
}

function advertisedReasoning(entry: Record<string, unknown>): boolean {
	const capabilities = entry.capabilities;
	return isRecord(capabilities) && (capabilities.thinking === true || capabilities.thinking_adaptive === true);
}

function toModel(entry: Record<string, unknown>, id: string, baseUrl: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: ACTUALYZE_PROVIDER_ID,
		baseUrl,
		reasoning: advertisedReasoning(entry),
		input: advertisedImageInput(entry) ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow:
			positiveSafeInteger(entry.context_window) ?? positiveSafeInteger(entry.max_model_len) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveSafeInteger(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
		compat: { ...ACTUALYZE_COMPAT },
	};
}

export function parseCatalog(payload: unknown, baseUrl: string): readonly Model<"openai-completions">[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new ActualyzeCatalogError("Actualyze /models response must be an object with a data array");
	}

	const ids = new Set<string>();
	return payload.data.map((value, index) => {
		if (!isRecord(value)) throw new ActualyzeCatalogError(`Model entry ${index} must be an object`);
		if (Object.hasOwn(value, "object") && value.object !== "model") {
			throw new ActualyzeCatalogError(`Model entry ${index} must advertise object "model" when present`);
		}
		const id = validateModelId(value.id, index);
		if (ids.has(id))
			throw new ActualyzeCatalogError(`Actualyze /models response contains a duplicate model id at entry ${index}`);
		ids.add(id);
		return toModel(value, id, baseUrl);
	});
}
