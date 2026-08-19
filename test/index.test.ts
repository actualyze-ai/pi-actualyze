import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import actualyzeExtension, { ACTUALYZE_PROVIDER_ID } from "../src/index.js";

describe("pi-actualyze extension entry", () => {
	it("exports the stable provider id", () => {
		expect(ACTUALYZE_PROVIDER_ID).toBe("actualyze");
	});

	it("registers the native Actualyze provider", () => {
		const registerProvider = vi.fn();
		actualyzeExtension({ registerProvider } as unknown as ExtensionAPI);
		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({ id: "actualyze", name: "Actualyze" });
	});
});
