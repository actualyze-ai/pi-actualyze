import type { Model } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { ACTUALYZE_PROVIDER_ID } from "../src/constants.js";
import { validateApiKey } from "../src/endpoint.js";
import { createGuardedFetch, getJson } from "../src/transport.js";

// Checks that a live Actualyze endpoint still returns a model list this
// provider parses. `npm run test:contract` sets ACTUALYZE_CONTRACT_TEST;
// without ACTUALYZE_BASE_URL and ACTUALYZE_API_KEY every test is skipped.
const baseUrl = process.env.ACTUALYZE_BASE_URL?.replace(/\/+$/u, "") ?? "";
const apiKey = process.env.ACTUALYZE_API_KEY ?? "";
const enabled = process.env.ACTUALYZE_CONTRACT_TEST === "1" && baseUrl !== "" && apiKey !== "";

type RawEntry = Record<string, unknown> & { id: string };

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

describe.skipIf(!enabled)("Actualyze /models contract", () => {
	let entries: RawEntry[] = [];
	let models: readonly Model<"openai-completions">[] = [];

	beforeAll(async () => {
		const payload = await getJson(`${baseUrl}/models`, validateApiKey(apiKey), {
			fetch: createGuardedFetch(baseUrl),
			signal: AbortSignal.timeout(30_000),
		});
		models = parseCatalog(payload, baseUrl);
		entries = (payload as { data: RawEntry[] }).data;
	}, 30_000);

	it("parses every listed model, in order, as an Actualyze model", () => {
		expect(models.length).toBeGreaterThan(0);
		expect(models.map((model) => model.id)).toEqual(entries.map((entry) => entry.id));
		for (const model of models) {
			expect(model).toMatchObject({
				provider: ACTUALYZE_PROVIDER_ID,
				api: "openai-completions",
				baseUrl,
			});
		}
	});

	it("still advertises the limit fields the provider maps", () => {
		const withContext = entries.filter(
			(entry) => positiveInteger(entry.context_window) ?? positiveInteger(entry.max_model_len),
		);
		const withOutput = entries.filter((entry) => positiveInteger(entry.max_output_tokens));
		expect(withContext.length).toBeGreaterThan(0);
		expect(withOutput.length).toBeGreaterThan(0);
	});

	it("carries advertised limits, image input, and reasoning into each model", () => {
		entries.forEach((entry, index) => {
			const model = models[index];
			const context = positiveInteger(entry.context_window) ?? positiveInteger(entry.max_model_len);
			const output = positiveInteger(entry.max_output_tokens);
			if (context !== undefined) expect(model.contextWindow, entry.id).toBe(context);
			if (output !== undefined) expect(model.maxTokens, entry.id).toBe(output);

			const input = record(entry.modalities).input;
			const image = Array.isArray(input) && input.includes("image");
			expect(model.input.includes("image"), entry.id).toBe(image);

			const capabilities = record(entry.capabilities);
			const reasoning = capabilities.thinking === true || capabilities.thinking_adaptive === true;
			expect(model.reasoning, entry.id).toBe(reasoning);
		});
	});

	it("carries each advertised cost into the model's rates", () => {
		entries.forEach((entry, index) => {
			const cost = entry.cost;
			if (!isObject(cost)) return;
			// The object is listed only when both required rates are known, and a
			// cache rate only when it is known.
			expect(isRate(cost.input), `${entry.id} cost.input`).toBe(true);
			expect(isRate(cost.output), `${entry.id} cost.output`).toBe(true);
			for (const field of ["cache_read", "cache_write"]) {
				if (cost[field] !== undefined) expect(isRate(cost[field]), `${entry.id} cost.${field}`).toBe(true);
			}
			const input = cost.input as number;
			expect(models[index]?.cost, entry.id).toEqual({
				input,
				output: cost.output,
				cacheRead: cost.cache_read ?? input,
				cacheWrite: cost.cache_write ?? input * 1.25,
			});
		});
	});
});
