import type { Model } from "@earendil-works/pi-ai";
import { parseCatalog } from "./catalog.js";
import { DEFAULT_REQUEST_BUDGET_MS } from "./constants.js";
import { createGuardedFetch, type FetchFunction, getJson, type TransportHooks } from "./transport.js";

export interface ActualyzeClientOptions extends TransportHooks {
	budgetMs?: number;
}

export class ActualyzeClient {
	readonly guardedFetch: FetchFunction;

	constructor(
		readonly baseUrl: string,
		readonly apiKey: string,
		private readonly options: ActualyzeClientOptions = {},
	) {
		this.guardedFetch = createGuardedFetch(baseUrl, options.fetch);
	}

	async list(signal?: AbortSignal): Promise<readonly Model<"openai-completions">[]> {
		const payload = await getJson(`${this.baseUrl}/models`, this.apiKey, {
			fetch: this.guardedFetch,
			signal,
			budgetMs: this.options.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS,
			now: this.options.now,
			sleep: this.options.sleep,
		});
		return parseCatalog(payload, this.baseUrl);
	}
}
