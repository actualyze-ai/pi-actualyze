import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../src/catalog.js";
import { createActualyzeProvider } from "../src/provider.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

async function runtime(
	credentials: InMemoryCredentialStore,
	modelsStore: InMemoryModelsStore,
	fetch: typeof globalThis.fetch,
	modelsPath: string | null = null,
): Promise<{
	controller: ReturnType<typeof createActualyzeProvider>;
	models: ModelRuntime;
}> {
	const controller = createActualyzeProvider({ fetch });
	const models = await ModelRuntime.create({
		credentials,
		modelsStore,
		modelsPath,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(controller.provider);
	return { controller, models };
}

function loginInteraction(target: string, key: string) {
	// Login does not prompt for a target; select it through ACTUALYZE_TARGET.
	vi.stubEnv("ACTUALYZE_TARGET", target);
	const answers = [key];
	return {
		signal: new AbortController().signal,
		prompt: vi.fn(async () => answers.shift() ?? ""),
		notify: vi.fn(),
	};
}

function completionResponse(): Response {
	const chunks = [
		{ delta: { role: "assistant", content: "OK" }, finish_reason: null },
		{ delta: {}, finish_reason: "stop" },
	].map((choice) => ({
		id: "completion-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "underlying-model",
		choices: [{ index: 0, ...choice }],
	}));
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function limits(model: { id: string; contextWindow?: number; maxTokens?: number }) {
	return {
		id: model.id,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

const context = {
	messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }],
};

describe("pi Models lifecycle integration", () => {
	it("logs in from empty stores, exposes the exact catalog, and restores it after restart", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const network = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				data: [modelEntry("catalog-a"), modelEntry("catalog-b")],
			}),
		);
		const first = await runtime(credentials, modelsStore, network);

		await first.models.login("actualyze", "api_key", loginInteraction("customer", "first-key"));
		expect(first.models.getModels("actualyze").map((model) => model.id)).toEqual(["catalog-a", "catalog-b"]);
		expect((await first.models.getAvailable("actualyze")).map((model) => model.id)).toEqual(["catalog-a", "catalog-b"]);
		await first.models.refresh({
			allowNetwork: false,
			providers: ["actualyze"],
		});
		expect((await modelsStore.read("actualyze"))?.models.map((model) => model.id)).toEqual(["catalog-a", "catalog-b"]);

		const restarted = await runtime(credentials, modelsStore, async () => {
			throw new Error("cache-only restart must not use the network");
		});
		const result = await restarted.models.refresh({
			allowNetwork: false,
			providers: ["actualyze"],
		});
		expect(result.errors.size).toBe(0);
		expect(restarted.models.getModels("actualyze").map((model) => model.id)).toEqual(["catalog-a", "catalog-b"]);
		expect((await restarted.models.getAvailable("actualyze")).map((model) => model.id)).toEqual([
			"catalog-a",
			"catalog-b",
		]);
	});

	it("makes cached models unavailable on logout and installs a re-login target catalog", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const network = vi.fn<typeof fetch>(async (input) => {
			const hostname = new URL(input instanceof Request ? input.url : input).hostname;
			return jsonResponse({
				data: [modelEntry(hostname.startsWith("second.") ? "second-model" : "first-model")],
			});
		});
		const instance = await runtime(credentials, modelsStore, network);
		await instance.models.login("actualyze", "api_key", loginInteraction("first", "first-key"));
		await instance.models.refresh({
			allowNetwork: false,
			providers: ["actualyze"],
		});
		expect((await instance.models.getAvailable("actualyze")).map((model) => model.id)).toEqual(["first-model"]);

		await instance.models.logout("actualyze");
		expect(await instance.models.getAvailable("actualyze")).toEqual([]);

		await instance.models.login("actualyze", "api_key", loginInteraction("second", "second-key"));
		expect(instance.models.getModels("actualyze").map((model) => model.id)).toEqual(["second-model"]);
		await instance.models.refresh({
			allowNetwork: false,
			providers: ["actualyze"],
		});
		expect((await modelsStore.read("actualyze"))?.models.map((model) => model.id)).toEqual(["second-model"]);
	});

	it("refuses a cross-target stream when the request env names another target", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const network = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.pathname.endsWith("/chat/completions")) {
				throw new Error("cross-target inference must be refused before dispatch");
			}
			return jsonResponse({ data: [modelEntry("shared-model-id")] });
		});
		const instance = await runtime(credentials, modelsStore, network);
		await instance.models.login("actualyze", "api_key", loginInteraction("target-a", "target-a-key"));
		const [model] = instance.models.getModels("actualyze");
		expect(model?.baseUrl).toBe("https://target-a.actualyze.ai/openai/v1");

		// The stored target-a credential wins auth resolution, so the model keeps
		// target A's baseUrl while the request env names target B: this exercises
		// the direct baseUrl-mismatch guard. (The next test covers pi's auth
		// rewrite and the catalog-provenance guard.)
		const result = await instance.models
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{ env: { ACTUALYZE_TARGET: "target-b" } },
			)
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/another target/u);
		expect(network).toHaveBeenCalledOnce();

		const accepted = network.mock.calls.every(
			(call) =>
				new URL(call[0] instanceof Request ? call[0].url : String(call[0])).hostname === "target-a.actualyze.ai",
		);
		expect(accepted).toBe(true);
	});

	it("refuses a retained foreign-catalog model id after a target switch rewrites its baseUrl", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const network = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.pathname.endsWith("/chat/completions")) {
				throw new Error("cross-target inference must be refused before dispatch");
			}
			return jsonResponse({
				data: [modelEntry(url.hostname.startsWith("target-b.") ? "b-only-model" : "a-only-model")],
			});
		});
		const instance = await runtime(credentials, modelsStore, network);
		await instance.models.login("actualyze", "api_key", loginInteraction("target-a", "target-a-key"));
		const [retainedA] = instance.models.getModels("actualyze");
		expect(retainedA?.id).toBe("a-only-model");
		expect(retainedA?.baseUrl).toBe("https://target-a.actualyze.ai/openai/v1");

		// Switch the stored credential to target B and install B's catalog, which
		// does not contain the retained A-only id.
		await credentials.modify("actualyze", async () => ({
			type: "api_key",
			key: "target-b-key",
			env: { ACTUALYZE_TARGET: "target-b" },
		}));
		await instance.models.refresh({ force: true, providers: ["actualyze"] });
		expect(instance.models.getModels("actualyze").map((model) => model.id)).toEqual(["b-only-model"]);

		// prepareRequest re-resolves auth (now target B) and rewrites the retained
		// model's baseUrl to B, so both baseUrl comparisons pass; only the
		// catalog-provenance check can refuse the A-only id.
		const result = await instance.models
			.streamSimple(retainedA, {
				messages: [{ role: "user", content: "Hello", timestamp: 1 }],
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/not in the discovered catalog/u);
		const inferenceCalls = network.mock.calls.filter((call) =>
			new URL(call[0] instanceof Request ? call[0].url : String(call[0])).pathname.endsWith("/chat/completions"),
		);
		expect(inferenceCalls).toEqual([]);
	});

	it("retains the last valid generation when refresh fails after same-target key rotation", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		let rejectRefresh = false;
		const network = vi.fn<typeof fetch>(async () =>
			rejectRefresh
				? new Response(JSON.stringify({ error: { message: "rotated key rejected" } }), {
						status: 401,
						headers: { "content-type": "application/json" },
					})
				: jsonResponse({ data: [modelEntry("last-valid")] }),
		);
		const instance = await runtime(credentials, modelsStore, network);
		await instance.models.login("actualyze", "api_key", loginInteraction("customer", "old-key"));
		await instance.models.refresh({
			allowNetwork: false,
			providers: ["actualyze"],
		});
		await credentials.modify("actualyze", async () => ({
			type: "api_key",
			key: "rotated-key",
			env: { ACTUALYZE_TARGET: "customer" },
		}));
		rejectRefresh = true;

		const refresh = await instance.models.refresh({
			force: true,
			providers: ["actualyze"],
		});
		expect(refresh.errors.get("actualyze")?.message).toMatch(/HTTP 401/u);
		expect(instance.models.getModels("actualyze").map((model) => model.id)).toEqual(["last-valid"]);
		expect((await modelsStore.read("actualyze"))?.models.map((model) => model.id)).toEqual(["last-valid"]);
	});
});

describe("models.json modelOverrides for Actualyze models", () => {
	const customerBaseUrl = "https://customer.actualyze.ai/openai/v1";
	const override = { contextWindow: 1_000_000, maxTokens: 32_000 };
	const overridden = { id: "unlisted-limits", ...override };
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** Writes a models.json that overrides the given Actualyze model ids and returns its path. */
	function modelsJson(modelOverrides: Record<string, Record<string, number>>): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-actualyze-models-json-"));
		tempDirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(path, JSON.stringify({ providers: { actualyze: { modelOverrides } } }));
		return path;
	}

	/**
	 * A listing entry without context_window or max_output_tokens, for which
	 * the catalog falls back to 128,000 and 16,384.
	 */
	function unlistedLimits(): Record<string, unknown> {
		return modelEntry("unlisted-limits", {
			context_window: undefined,
			max_output_tokens: undefined,
		});
	}

	it("applies an override's limits to the matching model after login", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const network = vi.fn<typeof fetch>(async () =>
			jsonResponse({ data: [unlistedLimits(), modelEntry("listed-limits")] }),
		);
		const instance = await runtime(credentials, modelsStore, network, modelsJson({ "unlisted-limits": override }));

		await instance.models.login("actualyze", "api_key", loginInteraction("customer", "customer-key"));
		expect(await instance.models.checkAuth("actualyze")).toEqual({
			type: "api_key",
			source: "stored credential",
		});
		const expected = [overridden, { id: "listed-limits", contextWindow: 200_000, maxTokens: 64_000 }];
		expect(instance.models.getModels("actualyze").map(limits)).toEqual(expected);
		expect((await instance.models.getAvailable("actualyze")).map(limits)).toEqual(expected);
	});

	it("hands the overridden model to the provider's guarded stream and streamSimple", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const requests: Array<{
			host: string;
			metadata: string | null;
			body: Record<string, unknown>;
		}> = [];
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const url = new URL(request.url);
			if (!url.pathname.endsWith("/chat/completions")) return jsonResponse({ data: [unlistedLimits()] });
			requests.push({
				host: url.hostname,
				metadata: request.headers.get("x-actualyze-request-metadata"),
				body: (await request.clone().json()) as Record<string, unknown>,
			});
			return completionResponse();
		});
		const instance = await runtime(credentials, modelsStore, network, modelsJson({ "unlisted-limits": override }));
		await instance.models.login("actualyze", "api_key", loginInteraction("customer", "customer-key"));
		const [model] = instance.models.getModels("actualyze");
		const streamSimple = vi.spyOn(instance.controller.provider, "streamSimple");
		const stream = vi.spyOn(instance.controller.provider, "stream");

		const simpleResult = await instance.models.streamSimple(model, context).result();
		const streamResult = await instance.models.stream(model, context).result();

		expect([simpleResult.stopReason, streamResult.stopReason]).toEqual(["stop", "stop"]);
		const expectedModel = expect.objectContaining({
			...overridden,
			baseUrl: customerBaseUrl,
		});
		expect(streamSimple).toHaveBeenCalledWith(expectedModel, expect.anything(), expect.anything());
		expect(stream).toHaveBeenCalledWith(expectedModel, expect.anything(), expect.anything());
		// streamSimple sizes the output budget from the model's maxTokens.
		expect(requests[0]?.body.max_completion_tokens).toBe(32_000);
		// Only the provider's own request path adds the metadata header, so both
		// requests passed its target guard and guarded fetch.
		expect(
			requests.map(({ host, metadata }) => ({
				host,
				guarded: metadata !== null,
			})),
		).toEqual([
			{ host: "customer.actualyze.ai", guarded: true },
			{ host: "customer.actualyze.ai", guarded: true },
		]);
	});

	it("keeps applying the override after a refresh publishes a new catalog generation", async () => {
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		let generation = 1;
		const network = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				data:
					generation === 1
						? [unlistedLimits()]
						: [
								modelEntry("unlisted-limits", {
									context_window: 400_000,
									max_output_tokens: 48_000,
								}),
								modelEntry("added-model"),
							],
			}),
		);
		const instance = await runtime(credentials, modelsStore, network, modelsJson({ "unlisted-limits": override }));
		await instance.models.login("actualyze", "api_key", loginInteraction("customer", "customer-key"));

		generation = 2;
		const refresh = await instance.models.refresh({
			force: true,
			providers: ["actualyze"],
		});
		expect(refresh.errors.size).toBe(0);
		expect(instance.models.getModels("actualyze").map(limits)).toEqual([
			overridden,
			{ id: "added-model", contextWindow: 200_000, maxTokens: 64_000 },
		]);
		// pi applies the override when it reads the catalog; the persisted
		// generation keeps the listed values, so removing the override restores them.
		expect((await modelsStore.read("actualyze"))?.models.map(limits)).toEqual([
			{ id: "unlisted-limits", contextWindow: 400_000, maxTokens: 48_000 },
			{ id: "added-model", contextWindow: 200_000, maxTokens: 64_000 },
		]);
	});

	it("applies the override to a catalog restored at startup for an environment-only key", async () => {
		vi.stubEnv("ACTUALYZE_API_KEY", "env-key");
		vi.stubEnv("ACTUALYZE_TARGET", "customer");
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("actualyze", {
			models: parseCatalog({ data: [unlistedLimits()] }, customerBaseUrl),
			checkedAt: 1,
		});
		const bodies: Record<string, unknown>[] = [];
		const network = vi.fn<typeof fetch>(async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
				throw new Error("cache-only startup must not list models");
			}
			bodies.push((await request.clone().json()) as Record<string, unknown>);
			return completionResponse();
		});
		const instance = await runtime(
			new InMemoryCredentialStore(),
			modelsStore,
			network,
			modelsJson({ "unlisted-limits": override }),
		);

		const restore = await instance.models.refresh({
			allowNetwork: false,
			providers: ["actualyze"],
		});
		expect(restore.errors.size).toBe(0);
		expect(await instance.models.checkAuth("actualyze")).toEqual({
			type: "api_key",
			source: "ACTUALYZE_API_KEY",
		});
		const [model] = await instance.models.getAvailable("actualyze");
		expect(limits(model)).toEqual(overridden);
		const result = await instance.models.streamSimple(model, context).result();
		expect(result.stopReason).toBe("stop");
		expect(bodies.map((body) => body.max_completion_tokens)).toEqual([32_000]);
	});
});
