import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch, getJson } from "../src/transport.js";
import { jsonResponse } from "./fixtures.js";

const baseUrl = "https://customer.actualyze.ai/openai/v1";

describe("guarded Actualyze transport", () => {
	it("rejects malformed and non-HTTPS base URLs before dispatch", () => {
		const underlying = vi.fn<typeof fetch>();
		expect(() => createGuardedFetch("not a URL", underlying)).toThrow(/request URL is invalid/u);
		expect(() => createGuardedFetch("http://customer.actualyze.ai/openai/v1", underlying)).toThrow(
			/base URL must use HTTPS/u,
		);
		expect(underlying).not.toHaveBeenCalled();
	});

	it("allows only the configured HTTPS origin and path prefix and forces redirect errors", async () => {
		const underlying = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
		const guarded = createGuardedFetch(baseUrl, underlying);

		await guarded(`${baseUrl}/models`, { redirect: "follow" });
		expect(underlying).toHaveBeenCalledOnce();
		expect(underlying.mock.calls[0]?.[1]?.redirect).toBe("error");

		for (const url of [
			"http://customer.actualyze.ai/openai/v1/models",
			"https://evil.example/openai/v1/models",
			"https://customer.actualyze.ai/openai/v10/models",
			"https://customer.actualyze.ai/models",
		]) {
			await expect(guarded(url)).rejects.toThrow(/outside the configured endpoint/u);
		}
		expect(underlying).toHaveBeenCalledOnce();
	});

	it.each([301, 302, 303, 307, 308])("rejects HTTP %i without following it", async (status) => {
		const underlying = vi.fn<typeof fetch>(
			async () =>
				new Response(null, {
					status,
					headers: { location: "https://evil.test" },
				}),
		);
		const guarded = createGuardedFetch(baseUrl, underlying);
		await expect(guarded(`${baseUrl}/models`)).rejects.toThrow(/redirects are not allowed/u);
		expect(underlying).toHaveBeenCalledOnce();
		expect(underlying.mock.calls[0]?.[1]?.redirect).toBe("error");
	});

	it("sanitizes non-success response bodies and headers", async () => {
		const secret = "echoed-api-key";
		const guarded = createGuardedFetch(
			baseUrl,
			async () =>
				new Response(JSON.stringify({ error: `Authorization: Bearer ${secret}` }), {
					status: 401,
					headers: {
						authorization: `Bearer ${secret}`,
						"x-debug": secret,
						"content-type": "application/json",
					},
				}),
		);
		const response = await guarded(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${secret}` },
		});
		const body = await response.text();
		expect(body).not.toContain(secret);
		expect(body).not.toMatch(/authorization/iu);
		expect(response.headers.has("authorization")).toBe(false);
		expect(response.headers.get("x-debug")).toBe("[REDACTED]");
	});

	it("redacts raw network failures and secrets while keeping the underlying message", async () => {
		const secret = "super-secret-pat";
		const guarded = createGuardedFetch(baseUrl, async () => {
			throw new Error(`failed with Authorization: Bearer ${secret}`);
		});
		const error = await guarded(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${secret}` },
		}).catch((value: unknown) => value);
		expect(String(error)).toContain("failed before receiving a response: failed with [REDACTED-HEADER]: [REDACTED]");
		expect(String(error)).not.toContain(secret);
		expect(String(error)).not.toContain("Authorization");
	});
});

describe("catalog JSON requests", () => {
	it("authenticates, validates JSON media types, and parses the response", async () => {
		const underlying = vi.fn<typeof fetch>(async (_input, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-secret");
			return jsonResponse({ data: [] }, { headers: { "content-type": "application/vnd.actualyze+json" } });
		});
		await expect(getJson(`${baseUrl}/models`, "api-secret", { fetch: underlying })).resolves.toEqual({ data: [] });
	});

	it("retries 429 and 5xx with bounded delay", async () => {
		let clock = 1_000;
		const sleep = vi.fn(async (milliseconds: number) => {
			clock += milliseconds;
		});
		const underlying = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0.01" } }))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(jsonResponse({ data: [] }));

		await expect(
			getJson(`${baseUrl}/models`, "key", {
				fetch: underlying,
				now: () => clock,
				sleep,
				budgetMs: 5_000,
			}),
		).resolves.toEqual({ data: [] });
		expect(underlying).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 10, expect.any(AbortSignal));
		expect(sleep).toHaveBeenNthCalledWith(2, 500, expect.any(AbortSignal));
	});

	it("honors a valid Retry-After longer than the fallback cap", async () => {
		let clock = 1_000;
		const sleep = vi.fn(async (milliseconds: number) => {
			clock += milliseconds;
		});
		const underlying = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "5" } }))
			.mockResolvedValueOnce(jsonResponse({ data: [] }));
		await expect(
			getJson(`${baseUrl}/models`, "key", {
				fetch: underlying,
				now: () => clock,
				sleep,
				budgetMs: 10_000,
			}),
		).resolves.toEqual({ data: [] });
		expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
	});

	it("does not retry authentication and validation failures", async () => {
		for (const status of [400, 401, 403, 404]) {
			const underlying = vi.fn<typeof fetch>(async () => new Response(null, { status }));
			await expect(getJson(`${baseUrl}/models`, "key", { fetch: underlying })).rejects.toThrow(`HTTP ${status}`);
			expect(underlying).toHaveBeenCalledOnce();
		}
	});

	it("includes a bounded redacted body excerpt in non-retryable HTTP failures", async () => {
		const secret = "getjson-error-secret";
		const filler = "x".repeat(600);
		const guarded = createGuardedFetch(
			baseUrl,
			async () =>
				new Response(`upstream rejected the request: Bearer ${secret} ${filler}`, {
					status: 401,
					headers: { "content-type": "text/plain" },
				}),
		);
		const error = await getJson(`${baseUrl}/models`, secret, {
			fetch: guarded,
		}).catch((value: unknown) => value);
		const message = String(error);
		expect(message).toContain("Actualyze request returned HTTP 401: upstream rejected the request");
		expect(message).not.toContain(secret);
		const excerpt = message.slice(message.indexOf("HTTP 401: ") + "HTTP 401: ".length);
		expect(excerpt.length).toBeLessThanOrEqual(500);
	});

	it("reports an abort during a non-retryable error-body read as aborted", async () => {
		let bodyRequested: (() => void) | undefined;
		const requested = new Promise<void>((resolve) => {
			bodyRequested = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			pull: () => {
				bodyRequested?.();
				return new Promise(() => {});
			},
		});
		const controller = new AbortController();
		const request = getJson(`${baseUrl}/models`, "key", {
			fetch: async () => new Response(body, { status: 401 }),
			signal: controller.signal,
		});
		await requested;
		controller.abort();
		const error = await request.catch((value: unknown) => value);
		expect(String(error)).toContain("was aborted");
		expect(String(error)).not.toContain("HTTP 401");
	});

	it("surfaces the undici cause chain for pre-response failures, redacted", async () => {
		const secret = "cause-chain-secret";
		const guarded = createGuardedFetch(baseUrl, async () => {
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("getaddrinfo ENOTFOUND customer.actualyze.ai"), { code: "ENOTFOUND" }),
			});
		});
		const error = await getJson(`${baseUrl}/models`, secret, {
			fetch: guarded,
		}).catch((value: unknown) => value);
		expect(String(error)).toContain("fetch failed: getaddrinfo ENOTFOUND customer.actualyze.ai");
		expect(String(error)).not.toContain(secret);
	});

	it("follows a nested cause.cause one level, redacted", async () => {
		const secret = "nested-cause-secret";
		const guarded = createGuardedFetch(baseUrl, async () => {
			throw new TypeError("fetch failed", {
				cause: new Error(`connect failed with Authorization: Bearer ${secret}`, {
					cause: Object.assign(new Error("certificate has expired"), {
						code: "CERT_HAS_EXPIRED",
					}),
				}),
			});
		});
		const error = await getJson(`${baseUrl}/models`, secret, {
			fetch: guarded,
		}).catch((value: unknown) => value);
		expect(String(error)).toContain("fetch failed: connect failed with [REDACTED-HEADER]: [REDACTED]");
		expect(String(error)).toContain("certificate has expired (CERT_HAS_EXPIRED)");
		expect(String(error)).not.toContain(secret);
	});

	it("unwraps the first error of an AggregateError cause, redacted", async () => {
		const secret = "aggregate-cause-secret";
		const guarded = createGuardedFetch(baseUrl, async () => {
			throw new TypeError("fetch failed", {
				cause: new AggregateError(
					[Object.assign(new Error(`connect refused 127.0.0.1:443 key ${secret}`), { code: "ECONNREFUSED" })],
					"",
				),
			});
		});
		const error = await getJson(`${baseUrl}/models`, secret, {
			fetch: guarded,
		}).catch((value: unknown) => value);
		expect(String(error)).toContain("fetch failed: connect refused 127.0.0.1:443 key [REDACTED] (ECONNREFUSED)");
		expect(String(error)).not.toContain(secret);
	});

	it("describes an empty-message error through its cause, redacted", async () => {
		const secret = "empty-message-secret";
		const guarded = createGuardedFetch(baseUrl, async () => {
			throw new Error("", {
				cause: new Error(`socket hang up sending Bearer ${secret}`),
			});
		});
		const error = await getJson(`${baseUrl}/models`, secret, {
			fetch: guarded,
		}).catch((value: unknown) => value);
		expect(String(error)).toContain("failed before receiving a response: socket hang up sending [REDACTED]");
		expect(String(error)).not.toContain(secret);
	});

	it("rejects missing media type, malformed JSON, and oversized bodies", async () => {
		await expect(
			getJson(`${baseUrl}/models`, "key", {
				fetch: async () => new Response("{}"),
			}),
		).rejects.toThrow(/was not JSON/u);
		await expect(
			getJson(`${baseUrl}/models`, "key", {
				fetch: async () =>
					new Response("{", {
						headers: { "content-type": "application/json" },
					}),
			}),
		).rejects.toThrow(/malformed JSON/u);
		await expect(
			getJson(`${baseUrl}/models`, "key", {
				fetch: async () => jsonResponse({ value: "too large" }),
				maxResponseBytes: 4,
			}),
		).rejects.toThrow(/size limit/u);
	});

	it("honors parent cancellation and the aggregate deadline", async () => {
		const waitForAbort: typeof fetch = async (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		const controller = new AbortController();
		const cancelled = getJson(`${baseUrl}/models`, "key", {
			fetch: waitForAbort,
			signal: controller.signal,
		});
		controller.abort();
		await expect(cancelled).rejects.toThrow(/aborted/u);
		await expect(getJson(`${baseUrl}/models`, "key", { fetch: waitForAbort, budgetMs: 5 })).rejects.toThrow(
			/5ms budget/u,
		);
	});

	it("reports an abort during a pending retry delay without another attempt", async () => {
		const underlying = vi.fn<typeof fetch>(async () => new Response(null, { status: 429 }));
		const controller = new AbortController();
		let markSleeping: (() => void) | undefined;
		const sleeping = new Promise<void>((resolve) => {
			markSleeping = resolve;
		});
		const sleep = vi.fn(
			(_milliseconds: number, signal: AbortSignal) =>
				new Promise<void>((_resolve, reject) => {
					markSleeping?.();
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		const request = getJson(`${baseUrl}/models`, "key", {
			fetch: underlying,
			sleep,
			now: () => 1_000,
			signal: controller.signal,
		});
		await sleeping;
		controller.abort();
		await expect(request).rejects.toThrow(/^Actualyze request was aborted$/u);
		expect(underlying).toHaveBeenCalledOnce();
	});

	it("enforces the aggregate deadline during a stalled body read", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull: () => new Promise(() => {}),
		});
		await expect(
			getJson(`${baseUrl}/models`, "key", {
				fetch: async () =>
					new Response(body, {
						headers: { "content-type": "application/json" },
					}),
				budgetMs: 5,
			}),
		).rejects.toThrow(/5ms budget/u);
	});

	it("cancels a stalled response body", async () => {
		let bodyCancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull: () => new Promise(() => {}),
			cancel: () => {
				bodyCancelled = true;
			},
		});
		const controller = new AbortController();
		const request = getJson(`${baseUrl}/models`, "key", {
			fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();
		await expect(request).rejects.toThrow(/aborted/u);
		expect(bodyCancelled).toBe(true);
	});
});
