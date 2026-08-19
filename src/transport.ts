import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_REQUEST_BUDGET_MS } from "./constants.js";

export type FetchFunction = typeof globalThis.fetch;

export interface TransportHooks {
	fetch?: FetchFunction;
	now?: () => number;
	sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface GetJsonOptions extends TransportHooks {
	signal?: AbortSignal;
	budgetMs?: number;
	maxResponseBytes?: number;
	maxAttempts?: number;
}

export class ActualyzeTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActualyzeTransportError";
	}
}

function safeRequestUrl(input: RequestInfo | URL): URL {
	try {
		return new URL(input instanceof Request ? input.url : input);
	} catch {
		throw new ActualyzeTransportError("Actualyze request URL is invalid");
	}
}

function isAllowedPath(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

function cancelBody(response: Response): void {
	try {
		void response.body?.cancel().catch(() => {
			// Best-effort cleanup for a response the client will not consume.
		});
	} catch {
		// Some synthetic responses throw synchronously during cancellation.
	}
}

function requestAuthorization(input: RequestInfo | URL, init?: RequestInit): string | undefined {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	if (init?.headers) {
		for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
	}
	return headers.get("authorization") ?? undefined;
}

function redactErrorText(text: string, authorization: string | undefined): string {
	let safe = text.replaceAll(/authorization/giu, "[REDACTED-HEADER]");
	if (authorization) {
		safe = safe.replaceAll(authorization, "[REDACTED]");
		const separator = authorization.indexOf(" ");
		const secret = separator >= 0 ? authorization.slice(separator + 1) : authorization;
		if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
	}
	return safe;
}

async function sanitizedErrorResponse(
	response: Response,
	authorization: string | undefined,
	signal: AbortSignal,
): Promise<Response> {
	let body: string;
	try {
		body = redactErrorText(await readBoundedBody(response, MAX_ERROR_RESPONSE_BYTES, signal), authorization);
	} catch {
		body = JSON.stringify({
			error: "Actualyze request failed; provider error body was unavailable",
		});
	}
	const headers = new Headers();
	for (const [name, value] of response.headers) {
		if (name.toLowerCase() === "authorization") continue;
		headers.set(name, redactErrorText(value, authorization));
	}
	headers.delete("content-length");
	headers.delete("content-encoding");
	return new Response(body, { status: response.status, headers });
}

function describeErrorCause(cause: unknown, depth = 0): string | undefined {
	if (!(cause instanceof Error) || depth > 1) return undefined;
	const root = cause instanceof AggregateError ? (cause.errors[0] as unknown) : undefined;
	const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
	const own =
		cause.message && code && !cause.message.includes(code) ? `${cause.message} (${code})` : cause.message || code;
	const nested = describeErrorCause(root ?? cause.cause, depth + 1);
	if (own && nested) return `${own}: ${nested}`;
	return own || nested;
}

function safeTransportError(error: unknown, authorization?: string): ActualyzeTransportError {
	if (error instanceof ActualyzeTransportError) return error;
	if (error instanceof DOMException && error.name === "AbortError") {
		return new ActualyzeTransportError("Actualyze request was aborted");
	}
	if (error instanceof Error) {
		const cause = describeErrorCause(error.cause);
		const detail = error.message && cause ? `${error.message}: ${cause}` : error.message || cause;
		if (detail) {
			const redacted = redactErrorText(detail, authorization);
			return new ActualyzeTransportError(`Actualyze request failed before receiving a response: ${redacted}`);
		}
	}
	return new ActualyzeTransportError("Actualyze request failed before receiving a response");
}

export function createGuardedFetch(baseUrl: string, underlyingFetch: FetchFunction = globalThis.fetch): FetchFunction {
	const base = safeRequestUrl(baseUrl);
	if (base.protocol !== "https:") throw new ActualyzeTransportError("Actualyze base URL must use HTTPS");
	const prefix = base.pathname.replace(/\/+$/u, "");

	return async (input, init) => {
		const url = safeRequestUrl(input);
		if (url.protocol !== "https:" || url.origin !== base.origin || !isAllowedPath(url.pathname, prefix)) {
			throw new ActualyzeTransportError("Refusing Actualyze request outside the configured endpoint");
		}
		try {
			const response = await underlyingFetch(input, {
				...init,
				redirect: "error",
			});
			if (response.status >= 300 && response.status < 400) {
				cancelBody(response);
				throw new ActualyzeTransportError("Actualyze redirects are not allowed");
			}
			if (!response.ok) {
				const signal = init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
				return await sanitizedErrorResponse(response, requestAuthorization(input, init), signal);
			}
			return response;
		} catch (error) {
			throw safeTransportError(error, requestAuthorization(input, init));
		}
	};
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timeout = setTimeout(resolve, milliseconds);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds) ? seconds * 1000 : undefined;
	}
	const date = Date.parse(trimmed);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function shouldRetry(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

const MAX_ERROR_EXCERPT_CHARACTERS = 500;

async function httpFailureError(
	response: Response,
	authorization: string | undefined,
	signal: AbortSignal,
): Promise<ActualyzeTransportError> {
	let excerpt = "";
	try {
		const body = await readBoundedBody(response, MAX_ERROR_RESPONSE_BYTES, signal);
		excerpt = redactErrorText(body, authorization).trim().slice(0, MAX_ERROR_EXCERPT_CHARACTERS);
	} catch (error) {
		cancelBody(response);
		// An abort or deadline during the error-body read must surface as the
		// aborted/budget error, not as an HTTP-status failure.
		if (signal.aborted) throw error;
	}
	return new ActualyzeTransportError(
		excerpt === ""
			? `Actualyze request returned HTTP ${response.status}`
			: `Actualyze request returned HTTP ${response.status}: ${excerpt}`,
	);
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	const cancelOnAbort = (): void => {
		void reader.cancel(signal.reason).catch(() => {
			// The caller reports the abort; cancellation is best-effort cleanup.
		});
	};
	signal.addEventListener("abort", cancelOnAbort, { once: true });
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new ActualyzeTransportError("Actualyze response exceeded the size limit");
			text += decoder.decode(chunk.value, { stream: true });
		}
		signal.throwIfAborted();
		return text + decoder.decode();
	} catch (error) {
		try {
			await reader.cancel();
		} catch {
			// Preserve the bounded-read error when cancellation also fails.
		}
		throw error;
	} finally {
		signal.removeEventListener("abort", cancelOnAbort);
		reader.releaseLock();
	}
}

export async function getJson(url: string, apiKey: string, options: GetJsonOptions = {}): Promise<unknown> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const budgetMs = options.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
	const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const maxAttempts = options.maxAttempts ?? 4;
	const deadline = now() + budgetMs;
	const guardedFetch = options.fetch ?? globalThis.fetch;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (options.signal?.aborted) throw new ActualyzeTransportError("Actualyze request was aborted");
		const remaining = deadline - now();
		if (remaining <= 0) throw new ActualyzeTransportError(`Actualyze request exceeded its ${budgetMs}ms budget`);
		const timeoutSignal = AbortSignal.timeout(Math.max(1, remaining));
		const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await guardedFetch(url, {
				headers: { Authorization: `Bearer ${apiKey}` },
				redirect: "error",
				signal,
			});
		} catch (error) {
			if (signal.aborted) {
				if (options.signal?.aborted) throw new ActualyzeTransportError("Actualyze request was aborted");
				throw new ActualyzeTransportError(`Actualyze request exceeded its ${budgetMs}ms budget`);
			}
			throw safeTransportError(error, `Bearer ${apiKey}`);
		}

		if (!response.ok) {
			if (!shouldRetry(response.status) || attempt === maxAttempts) {
				let failure: ActualyzeTransportError;
				try {
					failure = await httpFailureError(response, `Bearer ${apiKey}`, signal);
				} catch (error) {
					if (signal.aborted) {
						if (options.signal?.aborted) throw new ActualyzeTransportError("Actualyze request was aborted");
						throw new ActualyzeTransportError(`Actualyze request exceeded its ${budgetMs}ms budget`);
					}
					throw safeTransportError(error, `Bearer ${apiKey}`);
				}
				throw failure;
			}
			cancelBody(response);
			const requested = retryAfterMilliseconds(response.headers.get("retry-after"), now());
			const delay = requested ?? Math.min(250 * 2 ** (attempt - 1), 2000);
			if (delay >= deadline - now()) {
				throw new ActualyzeTransportError(`Actualyze request exceeded its ${budgetMs}ms budget`);
			}
			try {
				await sleep(delay, signal);
			} catch {
				if (options.signal?.aborted) throw new ActualyzeTransportError("Actualyze request was aborted");
				throw new ActualyzeTransportError(`Actualyze request exceeded its ${budgetMs}ms budget`);
			}
			continue;
		}

		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
			cancelBody(response);
			throw new ActualyzeTransportError("Actualyze response was not JSON");
		}
		let text: string;
		try {
			text = await readBoundedBody(response, maxBytes, signal);
		} catch (error) {
			if (signal.aborted) {
				if (options.signal?.aborted) throw new ActualyzeTransportError("Actualyze request was aborted");
				throw new ActualyzeTransportError(`Actualyze request exceeded its ${budgetMs}ms budget`);
			}
			throw safeTransportError(error, `Bearer ${apiKey}`);
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new ActualyzeTransportError("Actualyze response contained malformed JSON");
		}
	}
	throw new ActualyzeTransportError("Actualyze request exhausted retry attempts");
}
