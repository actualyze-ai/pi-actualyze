import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createActualyzeProvider } from "../src/provider.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

async function runtime(
	credentials: InMemoryCredentialStore,
	modelsStore: InMemoryModelsStore,
	fetch: typeof globalThis.fetch,
): Promise<{
	controller: ReturnType<typeof createActualyzeProvider>;
	models: ModelRuntime;
}> {
	const controller = createActualyzeProvider({ fetch });
	const models = await ModelRuntime.create({
		credentials,
		modelsStore,
		modelsPath: null,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(controller.provider);
	return { controller, models };
}

function loginInteraction(target: string, key: string) {
	const answers = [target, key];
	return {
		signal: new AbortController().signal,
		prompt: vi.fn(async () => answers.shift() ?? ""),
		notify: vi.fn(),
	};
}

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
