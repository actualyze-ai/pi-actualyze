import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { createActualyzeProvider } from "../src/provider.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

const baseUrl = "https://customer.actualyze.ai/openai/v1";

function sseResponse(): Response {
	const events = [
		{
			id: "completion-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "underlying-model",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		},
		{
			id: "completion-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "underlying-model",
			choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
		},
		{
			id: "completion-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "underlying-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		},
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("native guarded OpenAI streaming", () => {
	it("uses the guarded provider fetch and preserves requested alias identity", async () => {
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			expect(request.url).toBe(`${baseUrl}/chat/completions`);
			expect(request.method).toBe("POST");
			expect(request.headers.get("authorization")).toBe("Bearer stream-secret");
			expect(init?.redirect).toBe("error");
			const payload = (await request.clone().json()) as Record<string, unknown>;
			expect(payload).toMatchObject({
				model: "routed-alias",
				stream: true,
				max_completion_tokens: 64,
				stream_options: { include_usage: true },
			});
			expect(payload).not.toHaveProperty("store");
			return sseResponse();
		});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog({ data: [modelEntry("routed-alias")] }, baseUrl);
		const context: Context = {
			systemPrompt: "Be concise",
			messages: [{ role: "user", content: "Say OK", timestamp: 1 }],
		};
		const result = await controller.provider
			.streamSimple(model, context, {
				apiKey: "stream-secret",
				env: { ACTUALYZE_TARGET: "customer" },
				maxTokens: 64,
				fetch: async () => {
					throw new Error("caller fetch must not bypass the provider guard");
				},
			})
			.result();

		expect(result.model).toBe("routed-alias");
		expect(result.responseModel).toBe("underlying-model");
		expect(result.content).toEqual([{ type: "text", text: "OK" }]);
		expect(result.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 });
		expect(network).toHaveBeenCalledOnce();
	});

	it("redacts credentials echoed by an inference error response", async () => {
		const secret = "echoed-stream-secret";
		const network: typeof fetch = async () =>
			new Response(JSON.stringify({ error: `Authorization: Bearer ${secret}` }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog({ data: [modelEntry("error-model")] }, baseUrl);
		const context: Context = {
			messages: [{ role: "user", content: "Fail safely", timestamp: 1 }],
		};
		const result = await controller.provider
			.streamSimple(model, context, {
				apiKey: secret,
				env: { ACTUALYZE_TARGET: "customer" },
				maxRetries: 0,
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain(secret);
		expect(result.errorMessage).not.toMatch(/authorization/iu);
	});

	it("rejects a stale model before sending the active target credential", () => {
		const network = vi.fn<typeof fetch>();
		const controller = createActualyzeProvider({ fetch: network });
		const [stale] = parseCatalog({ data: [modelEntry("stale")] }, "https://old.actualyze.ai/openai/v1");
		expect(() =>
			controller.provider.streamSimple(
				stale,
				{ messages: [] },
				{
					apiKey: "new-target-secret",
					env: { ACTUALYZE_TARGET: "customer" },
				},
			),
		).toThrow(/another target/u);
		expect(network).not.toHaveBeenCalled();
	});

	it("rejects a retained model id absent from the active target's catalog", async () => {
		// After a target switch pi rewrites model.baseUrl from resolved auth, so a
		// target-A-only id arrives with target B's baseUrl. The catalog-provenance
		// check must still refuse it when B's installed catalog lacks the id.
		const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("b-only-model")] }));
		const controller = createActualyzeProvider({ fetch: network });
		await controller.provider.refreshModels?.({
			credential: {
				type: "api_key",
				key: "b-key",
				env: { ACTUALYZE_TARGET: "target-b" },
			},
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		const [retainedA] = parseCatalog({ data: [modelEntry("a-only-model")] }, "https://target-b.actualyze.ai/openai/v1");
		network.mockClear();
		expect(() =>
			controller.provider.streamSimple(
				retainedA,
				{ messages: [] },
				{
					apiKey: "b-key",
					env: { ACTUALYZE_TARGET: "target-b" },
				},
			),
		).toThrow(/not in the discovered catalog/u);
		expect(network).not.toHaveBeenCalled();
	});
});
