import { describe, expect, it } from "vitest";
import { actualyzeBaseUrl, normalizeTarget, validateApiKey } from "../src/endpoint.js";

describe("Actualyze endpoint configuration", () => {
	it.each(["a", "customer", "TEAM-42", `a${"b".repeat(61)}z`])("accepts and canonicalizes %s", (value) => {
		expect(normalizeTarget(value)).toBe(value.toLowerCase());
	});

	it.each([
		"",
		" customer",
		"customer ",
		"foo.bar",
		"https://foo",
		"foo/path",
		"foo:443",
		"-foo",
		"foo-",
		"føø",
		"K",
		"ſ",
		"cuſtomer",
		"foo\nbar",
		`a${"b".repeat(63)}`,
	])("rejects unsafe target %j", (value) => {
		expect(() => normalizeTarget(value)).toThrow(/one ASCII DNS label/u);
	});

	it("constructs the fixed production endpoint", () => {
		expect(actualyzeBaseUrl("Customer")).toBe("https://customer.actualyze.ai/openai/v1");
	});

	it("validates visible-ASCII API keys without returning surrounding whitespace", () => {
		expect(validateApiKey("  secret-token  ")).toBe("secret-token");
		expect(() => validateApiKey("secret token")).toThrow(/visible-ASCII/u);
		expect(() => validateApiKey("\n\t")).toThrow(/visible-ASCII/u);
	});
});
