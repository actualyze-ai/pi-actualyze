import { type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { actualyzeBaseUrl, normalizeTarget, validateApiKey } from "../src/endpoint.js";
import { createActualyzeProvider } from "../src/provider.js";
import { createGuardedFetch, getJson } from "../src/transport.js";

const target = process.env.ACTUALYZE_TARGET;
const apiKey = process.env.ACTUALYZE_API_KEY;
const live = process.env.ACTUALYZE_LIVE_TEST === "1" && target !== undefined && apiKey !== undefined;
const liveModel = process.env.ACTUALYZE_LIVE_MODEL;
const liveInference = live && process.env.ACTUALYZE_LIVE_INFERENCE === "1" && liveModel !== undefined;
const advisoryModel = process.env.ACTUALYZE_LIVE_ADVISORY_MODEL;
const liveAdvisory = live && process.env.ACTUALYZE_LIVE_INFERENCE === "1" && advisoryModel !== undefined;

describe.skipIf(!live)("Actualyze live catalog", () => {
	it("preserves exact raw catalog ID and count parity", async () => {
		const baseUrl = actualyzeBaseUrl(normalizeTarget(target ?? ""));
		const payload = await getJson(`${baseUrl}/models`, validateApiKey(apiKey ?? ""), {
			fetch: createGuardedFetch(baseUrl),
			signal: AbortSignal.timeout(12_000),
		});
		const models = parseCatalog(payload, baseUrl);
		const rawIds = (payload as { data: Array<{ id: string }> }).data.map((entry) => entry.id);
		expect(models.length).toBeGreaterThan(0);
		expect(models.map((model) => model.id)).toEqual(rawIds);
		expect(new Set(rawIds).size).toBe(rawIds.length);
	});
});

describe.skipIf(!liveInference)("Actualyze live inference", () => {
	it("completes a native streamed tool loop", async () => {
		const normalizedTarget = normalizeTarget(target ?? "");
		const baseUrl = actualyzeBaseUrl(normalizedTarget);
		const secret = validateApiKey(apiKey ?? "");
		const [model] = parseCatalog(
			{
				data: [
					{
						id: liveModel,
						object: "model",
						capabilities: { thinking: true, tool_use: true, streaming: true },
						modalities: { input: ["text"] },
					},
				],
			},
			baseUrl,
		);
		const provider = createActualyzeProvider().provider;
		const tools = [
			{
				name: "echo",
				description: "Echo the supplied value",
				parameters: Type.Object({ value: Type.String() }),
			},
		];
		const user = { role: "user" as const, content: "Call echo with the exact value OK.", timestamp: Date.now() };
		const options = {
			apiKey: secret,
			env: { ACTUALYZE_TARGET: normalizedTarget },
			reasoningEffort: "low" as const,
			maxTokens: 512,
			timeoutMs: 90_000,
			signal: AbortSignal.timeout(90_000),
		};
		const first = await provider
			.stream(model, { messages: [user], tools }, { ...options, toolChoice: "required" })
			.result();
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ name: "echo", arguments: { value: "OK" } });
		if (!toolCall || toolCall.type !== "toolCall") {
			throw new Error("Actualyze live model did not return the required tool call");
		}
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "OK" }],
			isError: false,
			timestamp: Date.now(),
		};
		const second = await provider.stream(model, { messages: [user, first, result], tools }, options).result();
		expect(second.stopReason).not.toBe("error");
		expect(second.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(true);
	}, 120_000);
});

describe.skipIf(!liveAdvisory)("Actualyze live advisory flags", () => {
	it("streams from a catalog entry advertising streaming and tool use as false", async () => {
		const normalizedTarget = normalizeTarget(target ?? "");
		const baseUrl = actualyzeBaseUrl(normalizedTarget);
		const secret = validateApiKey(apiKey ?? "");
		const payload = (await getJson(`${baseUrl}/models`, secret, {
			fetch: createGuardedFetch(baseUrl),
			signal: AbortSignal.timeout(12_000),
		})) as { data: Array<Record<string, unknown>> };
		const entry = payload.data.find((candidate) => candidate.id === advisoryModel);
		expect(entry).toBeDefined();
		expect(entry?.capabilities).toMatchObject({ streaming: false, tool_use: false });
		const [model] = parseCatalog({ data: [entry] }, baseUrl);
		const result = await createActualyzeProvider()
			.provider.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] },
				{
					apiKey: secret,
					env: { ACTUALYZE_TARGET: normalizedTarget },
					maxTokens: 256,
					timeoutMs: 90_000,
					signal: AbortSignal.timeout(90_000),
				},
			)
			.result();
		expect(result.stopReason).not.toBe("error");
		expect(result.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(true);
	}, 120_000);
});
