import { describe, expect, it, vi } from "vitest";
import { ActualyzeClient } from "../src/client.js";
import { jsonResponse, modelEntry } from "./fixtures.js";

const baseUrl = "https://customer.actualyze.ai/openai/v1";

describe("Actualyze client aggregate budget", () => {
	it("applies the default 10-second budget when no budgetMs option is given", async () => {
		const network = vi.fn<typeof fetch>();
		const times = [0, 10_000];
		const client = new ActualyzeClient(baseUrl, "key", {
			fetch: network,
			now: () => times.shift() ?? 10_000,
		});
		await expect(client.list()).rejects.toThrow(/exceeded its 10000ms budget/u);
		expect(network).not.toHaveBeenCalled();
	});

	it("dispatches while the clock remains inside the default budget", async () => {
		const network = vi.fn<typeof fetch>(async () => jsonResponse({ data: [modelEntry("in-budget")] }));
		const times = [0, 9_000];
		const client = new ActualyzeClient(baseUrl, "key", {
			fetch: network,
			now: () => times.shift() ?? 9_000,
		});
		await expect(client.list()).resolves.toMatchObject([{ id: "in-budget" }]);
		expect(network).toHaveBeenCalledOnce();
	});
});
