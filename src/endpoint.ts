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

export function actualyzeHost(target: string): string {
	return `${normalizeTarget(target)}.actualyze.ai`;
}

export function actualyzeBaseUrl(target: string): string {
	return `https://${actualyzeHost(target)}${ACTUALYZE_API_PATH}`;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a URL hostname names this machine, the only place plain HTTP may carry a key. */
export function isLoopbackHostname(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Validate a full base URL, such as `ACTUALYZE_OPENAI_BASE_URL`, and return it
 * with the origin as `URL` serializes it (lowercase scheme and host, no
 * default port) and no trailing slash. HTTPS is required except on loopback.
 */
export function normalizeBaseUrl(value: string): string {
	if (value !== value.trim() || !URL.canParse(value)) {
		throw new ActualyzeConfigurationError("Actualyze base URL must be an absolute https URL");
	}
	const url = new URL(value);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
		throw new ActualyzeConfigurationError(
			"Actualyze base URL must use https (http only for localhost, 127.0.0.1, or [::1])",
		);
	}
	if (url.username !== "" || url.password !== "") {
		throw new ActualyzeConfigurationError("Actualyze base URL must not contain credentials");
	}
	if (url.search !== "" || url.hash !== "") {
		throw new ActualyzeConfigurationError("Actualyze base URL must not have a query or fragment");
	}
	return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** How the login prompt names an endpoint: its host, or the whole origin when it is plain HTTP. */
export function endpointLabel(baseUrl: string): string {
	const url = new URL(baseUrl);
	return url.protocol === "https:" ? url.host : url.origin;
}

export function validateApiKey(value: string): string {
	const key = value.trim();
	if (!/^[!-~]+$/u.test(key)) {
		throw new ActualyzeConfigurationError("Actualyze API key must be a non-empty visible-ASCII token");
	}
	return key;
}
