import { ACTUALYZE_API_PATH } from "./constants.js";

const TARGET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export class ActualyzeConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActualyzeConfigurationError";
	}
}

export function normalizeTarget(value: string): string {
	if (Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)) {
		throw new ActualyzeConfigurationError(
			"Actualyze target must be one ASCII DNS label (letters, digits, or internal hyphens; 1-63 characters)",
		);
	}
	const target = value.toLowerCase();
	if (!TARGET_PATTERN.test(target)) {
		throw new ActualyzeConfigurationError(
			"Actualyze target must be one ASCII DNS label (letters, digits, or internal hyphens; 1-63 characters)",
		);
	}
	return target;
}

export function actualyzeBaseUrl(target: string): string {
	return `https://${normalizeTarget(target)}.actualyze.ai${ACTUALYZE_API_PATH}`;
}

export function validateApiKey(value: string): string {
	const key = value.trim();
	if (!/^[!-~]+$/u.test(key)) {
		throw new ActualyzeConfigurationError("Actualyze API key must be a non-empty visible-ASCII token");
	}
	return key;
}
