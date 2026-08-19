import { type Context, isContextOverflow, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { createActualyzeProvider } from "../src/provider.js";
import { modelEntry } from "./fixtures.js";

const baseUrl = "https://customer.actualyze.ai/openai/v1";
const requestOptions = {
	apiKey: "contract-secret",
	env: { ACTUALYZE_TARGET: "customer" },
} as const;

function sse(events: unknown[]): Response {
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function chunk(
	delta: Record<string, unknown>,
	finishReason: string | null = null,
	usage?: Record<string, number>,
): unknown {
	return {
		id: "completion-contract",
		object: "chat.completion.chunk",
		created: 1,
		model: "actual-upstream-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

describe("Actualyze native OpenAI contract", () => {
	it("sends the exact conservative request shape and replays observable reasoning", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			payloads.push((await request.json()) as Record<string, unknown>);
			return payloads.length === 1
				? sse([
						chunk({ reasoning_content: "checked constraints" }),
						chunk({ content: "answer" }),
						chunk({}, "stop", {
							prompt_tokens: 8,
							completion_tokens: 3,
							total_tokens: 11,
						}),
					])
				: sse([chunk({ content: "continued" }), chunk({}, "stop")]);
		});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog({ data: [modelEntry("reasoning-alias")] }, baseUrl);
		const firstContext: Context = {
			systemPrompt: "System contract",
			messages: [{ role: "user", content: "Solve this", timestamp: 1 }],
			tools: [
				{
					name: "lookup",
					description: "Look up a value",
					parameters: Type.Object({ key: Type.String() }, { additionalProperties: false }),
				},
			],
		};
		const first = await controller.provider
			.streamSimple(model, firstContext, {
				...requestOptions,
				maxTokens: 321,
				reasoning: "high",
			})
			.result();
		const firstPayload = payloads[0] as {
			messages: Array<Record<string, unknown>>;
			tools: Array<{ function: Record<string, unknown> }>;
			[key: string]: unknown;
		};
		expect(firstPayload).toMatchObject({
			model: "reasoning-alias",
			stream: true,
			max_completion_tokens: 321,
			reasoning_effort: "high",
			stream_options: { include_usage: true },
		});
		expect(firstPayload).not.toHaveProperty("store");
		expect(firstPayload.messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(firstPayload.messages.some((message) => message.role === "developer")).toBe(false);
		expect(firstPayload.tools[0]?.function).not.toHaveProperty("strict");
		expect(first.content).toEqual([
			{
				type: "thinking",
				thinking: "checked constraints",
				thinkingSignature: "reasoning_content",
			},
			{ type: "text", text: "answer" },
		]);
		expect(first.responseModel).toBe("actual-upstream-model");

		await controller.provider
			.streamSimple(
				model,
				{
					systemPrompt: "System contract",
					messages: [...firstContext.messages, first],
				},
				requestOptions,
			)
			.result();
		const replayMessages = payloads[1]?.messages as Array<Record<string, unknown>>;
		const replayedAssistant = replayMessages.find((message) => message.role === "assistant");
		expect(replayedAssistant).toMatchObject({
			content: "answer",
			reasoning_content: "checked constraints",
		});
	});

	it("round-trips a streamed tool call and tool-result continuation", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			payloads.push((await request.json()) as Record<string, unknown>);
			return payloads.length === 1
				? sse([
						chunk({
							tool_calls: [
								{
									index: 0,
									id: "call_lookup",
									type: "function",
									function: { name: "lookup", arguments: "" },
								},
							],
						}),
						chunk({
							tool_calls: [{ index: 0, function: { arguments: '{"key":"status"}' } }],
						}),
						chunk({}, "tool_calls"),
					])
				: sse([chunk({ content: "Status is green" }), chunk({}, "stop")]);
		});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog({ data: [modelEntry("tool-alias")] }, baseUrl);
		const tools = [
			{
				name: "lookup",
				description: "Look up a value",
				parameters: Type.Object({ key: Type.String() }),
			},
		];
		const user = {
			role: "user" as const,
			content: "Check status",
			timestamp: 1,
		};
		const first = await controller.provider.streamSimple(model, { messages: [user], tools }, requestOptions).result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toEqual([
			{
				type: "toolCall",
				id: "call_lookup",
				name: "lookup",
				arguments: { key: "status" },
			},
		]);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_lookup",
			toolName: "lookup",
			content: [{ type: "text", text: "green" }],
			isError: false,
			timestamp: 2,
		};
		const second = await controller.provider
			.streamSimple(model, { messages: [user, first, toolResult], tools }, requestOptions)
			.result();
		expect(second.content).toEqual([{ type: "text", text: "Status is green" }]);
		const continuation = payloads[1]?.messages as Array<Record<string, unknown>>;
		expect(continuation.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
		expect(continuation[1]).toMatchObject({
			tool_calls: [
				{
					id: "call_lookup",
					type: "function",
					function: { name: "lookup", arguments: '{"key":"status"}' },
				},
			],
		});
		expect(continuation[2]).toMatchObject({
			tool_call_id: "call_lookup",
			content: "green",
		});
	});

	it("encodes image and Unicode content for a model with false advisory capability flags", async () => {
		let payload: Record<string, unknown> | undefined;
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			payload = (await request.json()) as Record<string, unknown>;
			return sse([chunk({ content: "Unicode and image accepted" }), chunk({}, "stop")]);
		});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog(
			{
				data: [
					modelEntry("advisory-false", {
						capabilities: {
							tool_use: false,
							streaming: false,
							thinking: false,
							thinking_adaptive: false,
						},
					}),
				],
			},
			baseUrl,
		);
		expect(model.input).toEqual(["text", "image"]);
		const result = await controller.provider
			.streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Unicode survives: K ſ 日本語 😀" },
								{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
							],
							timestamp: 1,
						},
					],
				},
				requestOptions,
			)
			.result();
		expect(result.stopReason).toBe("stop");
		expect(payload).toMatchObject({
			model: "advisory-false",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Unicode survives: K ſ 日本語 😀" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
						},
					],
				},
			],
		});
	});

	it("sends the tools schema unchanged to a model advertising tool_use and streaming false", async () => {
		let payload: Record<string, unknown> | undefined;
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			payload = (await request.json()) as Record<string, unknown>;
			return sse([
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_status",
							type: "function",
							function: { name: "lookup", arguments: "" },
						},
					],
				}),
				chunk({
					tool_calls: [{ index: 0, function: { arguments: '{"key":"status"}' } }],
				}),
				chunk({}, "tool_calls"),
			]);
		});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog(
			{
				data: [
					modelEntry("advisory-false-tools", {
						capabilities: {
							tool_use: false,
							streaming: false,
							thinking: false,
							thinking_adaptive: false,
						},
					}),
				],
			},
			baseUrl,
		);
		const result = await controller.provider
			.streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Check status", timestamp: 1 }],
					tools: [
						{
							name: "lookup",
							description: "Look up a value",
							parameters: Type.Object({ key: Type.String() }),
						},
					],
				},
				requestOptions,
			)
			.result();
		expect(payload).toMatchObject({
			model: "advisory-false-tools",
			stream: true,
			tools: [
				{
					type: "function",
					function: {
						name: "lookup",
						description: "Look up a value",
						parameters: {
							type: "object",
							properties: { key: { type: "string" } },
						},
					},
				},
			],
		});
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_status",
				name: "lookup",
				arguments: { key: "status" },
			},
		]);
	});

	it("propagates inference cancellation to the guarded native request", async () => {
		let requestSignal: AbortSignal | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			requestSignal = request.signal;
			markStarted?.();
			return await new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
			});
		});
		const controller = createActualyzeProvider({ fetch: network });
		const [model] = parseCatalog({ data: [modelEntry("abort-model")] }, baseUrl);
		const abort = new AbortController();
		const resultPromise = controller.provider
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Cancel me", timestamp: 1 }] },
				{ ...requestOptions, signal: abort.signal },
			)
			.result();
		await started;
		abort.abort(new Error("caller cancelled"));
		const result = await resultPromise;
		expect(requestSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("aborted");
	});

	it("surfaces a pi-recognized context overflow without misclassifying rate limits", async () => {
		const [model] = parseCatalog({ data: [modelEntry("overflow-model")] }, baseUrl);
		const context: Context = {
			messages: [{ role: "user", content: "Long prompt", timestamp: 1 }],
		};
		const overflowProvider = createActualyzeProvider({
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "context_length_exceeded: prompt has too many tokens",
						},
					}),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				),
		});
		const overflow = await overflowProvider.provider
			.streamSimple(model, context, { ...requestOptions, maxRetries: 0 })
			.result();
		expect(overflow.stopReason).toBe("error");
		expect(isContextOverflow(overflow, model.contextWindow)).toBe(true);

		const throttledProvider = createActualyzeProvider({
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: { message: "rate limit: too many tokens; retry later" },
					}),
					{
						status: 429,
						headers: { "content-type": "application/json" },
					},
				),
		});
		const throttled = await throttledProvider.provider
			.streamSimple(model, context, { ...requestOptions, maxRetries: 0 })
			.result();
		expect(isContextOverflow(throttled, model.contextWindow)).toBe(false);
	});
});
