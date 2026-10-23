import { describe, expect, it } from "vitest";
import { ACTUALYZE_COMPAT, parseCatalog } from "../src/catalog.js";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MAX_MODEL_ID_LENGTH } from "../src/constants.js";
import representativeCatalog from "./fixtures/actualyze-catalog.json";
import { modelEntry } from "./fixtures.js";

const baseUrl = "https://customer.actualyze.ai/openai/v1";

describe("Actualyze catalog conversion", () => {
	it("preserves exact membership and maps supported metadata", () => {
		const models = parseCatalog(
			{
				data: [
					modelEntry("vision-reasoning"),
					modelEntry("text-only", {
						context_window: null,
						max_model_len: 99_000,
						max_output_tokens: null,
						capabilities: {
							thinking: false,
							thinking_adaptive: false,
							tool_use: false,
							streaming: false,
						},
						modalities: { input: ["text", "pdf", "audio"] },
					}),
				],
			},
			baseUrl,
		);

		expect(models.map((model) => model.id)).toEqual(["vision-reasoning", "text-only"]);
		expect(models[0]).toMatchObject({
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
			baseUrl,
			compat: ACTUALYZE_COMPAT,
		});
		expect(models[1]).toMatchObject({
			input: ["text"],
			reasoning: false,
			contextWindow: 99_000,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	});

	it("uses documented numeric and unknown-cost sentinels", () => {
		const [model] = parseCatalog(
			{
				data: [
					modelEntry("unknown", {
						context_window: -1,
						max_model_len: Number.NaN,
						max_output_tokens: 0,
					}),
				],
			},
			baseUrl,
		);
		expect(model).toMatchObject({
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it.each([
		["Infinity", Number.POSITIVE_INFINITY],
		["-Infinity", Number.NEGATIVE_INFINITY],
		["fractional", 1024.5],
		["string-typed number", "2048"],
	])("falls back to sentinels for %s limit metadata", (_label, hostile) => {
		const [model] = parseCatalog(
			{
				data: [
					modelEntry("hostile", {
						context_window: hostile,
						max_model_len: hostile,
						max_output_tokens: hostile,
					}),
				],
			},
			baseUrl,
		);
		expect(model).toMatchObject({
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	});

	it("preserves contradictory-but-valid limits without clamping", () => {
		const [model] = parseCatalog(
			{
				data: [
					modelEntry("contradictory", {
						context_window: 8_192,
						max_output_tokens: 65_536,
					}),
				],
			},
			baseUrl,
		);
		// max_output_tokens > context_window is advertised as-is; the parser does
		// not invent a clamp between independently valid values.
		expect(model).toMatchObject({ contextWindow: 8_192, maxTokens: 65_536 });
	});

	it.each([
		["invalid envelope", null],
		["missing data", {}],
		["non-array data", { data: {} }],
		["non-object entry", { data: [null] }],
		["missing id", { data: [{ object: "model" }] }],
		["non-model object", { data: [modelEntry("x", { object: "collection" })] }],
		["duplicate id", { data: [modelEntry("x"), modelEntry("x")] }],
		["dot id", { data: [modelEntry(".")] }],
		["dot-dot id", { data: [modelEntry("..")] }],
		["control id", { data: [modelEntry("bad\u001bmodel")] }],
		["bidi id", { data: [modelEntry("bad\u202emodel")] }],
		["unpaired surrogate id", { data: [modelEntry("bad\ud800model")] }],
		["oversized id", { data: [modelEntry("x".repeat(MAX_MODEL_ID_LENGTH + 1))] }],
	])("fails the complete generation for %s", (_label, payload) => {
		expect(() => parseCatalog(payload, baseUrl)).toThrow();
	});

	it("does not echo a secret-shaped duplicated id in the error message", () => {
		const secretShapedId = `sk-${"a1B2c3D4e5".repeat(4)}`;
		const error = ((): unknown => {
			try {
				parseCatalog({ data: [modelEntry(secretShapedId), modelEntry(secretShapedId)] }, baseUrl);
				return undefined;
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(String(error)).toMatch(/duplicate model id at entry 1/u);
		expect(String(error)).not.toContain(secretShapedId);
	});

	it("preserves parity for a representative 34-entry catalog", () => {
		const models = parseCatalog(representativeCatalog, baseUrl);
		expect(models).toHaveLength(34);
		expect(models.map((model) => model.id)).toEqual(representativeCatalog.data.map((entry) => entry.id));
		expect(models[0]).toMatchObject({
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
		expect(models[0]?.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(models[1]?.input).toEqual(["text", "image"]);
		expect(models[2]).toMatchObject({ contextWindow: 272_000 });
		expect(models[2]?.cost).toEqual({
			input: 1,
			output: 2,
			cacheRead: 1,
			cacheWrite: 1.25,
		});
	});

	it("does not filter foreign owners or advisory false capability flags", () => {
		const models = parseCatalog(
			{
				data: [
					modelEntry("foreign", {
						owned_by: "other",
						capabilities: { streaming: false, tool_use: false },
					}),
				],
			},
			baseUrl,
		);
		expect(models).toHaveLength(1);
	});
});

describe("Actualyze catalog cost", () => {
	const unknownCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const costOf = (cost: unknown) => parseCatalog({ data: [modelEntry("priced", { cost })] }, baseUrl)[0]?.cost;

	it.each([
		["null", null],
		["a bare number", 3],
	])("keeps the unknown-price 0 for every rate when cost is %s", (_label, cost) => {
		expect(costOf(cost)).toEqual(unknownCost);
	});

	it("maps each listed rate, in dollars per million tokens, to the matching pi rate", () => {
		const listed = { input: 3, output: 15, cache_read: 0.3, cache_write: 6 };
		expect(costOf(listed)).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 6,
		});
	});

	it("estimates unlisted cache rates from the input rate", () => {
		// Cache reads fall back to the input rate, cache writes to 1.25 times it.
		const listed = { input: 2, output: 8 };
		expect(costOf(listed)).toEqual({
			input: 2,
			output: 8,
			cacheRead: 2,
			cacheWrite: 2.5,
		});
	});

	it("keeps listed zero cache rates instead of estimating them", () => {
		const listed = { input: 3, output: 15, cache_read: 0, cache_write: 0 };
		expect(costOf(listed)).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	const malformedRates = [
		["negative", -1],
		["infinite", Number.POSITIVE_INFINITY],
		["string-typed", "3"],
	];

	it.each(malformedRates)("falls back to 0 for a %s input or output rate alone", (_label, malformed) => {
		const [badInput, badOutput] = parseCatalog(
			{
				data: [
					modelEntry("bad-input", { cost: { input: malformed, output: 15 } }),
					modelEntry("bad-output", { cost: { input: 3, output: malformed } }),
				],
			},
			baseUrl,
		);
		expect(badInput?.cost).toEqual({
			input: 0,
			output: 15,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(badOutput?.cost).toEqual({
			input: 3,
			output: 0,
			cacheRead: 3,
			cacheWrite: 3.75,
		});
	});

	it.each(malformedRates)("estimates a %s cache rate from the input rate", (_label, malformed) => {
		const listed = {
			input: 4,
			output: 8,
			cache_read: malformed,
			cache_write: malformed,
		};
		expect(costOf(listed)).toEqual({
			input: 4,
			output: 8,
			cacheRead: 4,
			cacheWrite: 5,
		});
	});
});
