import { describe, expect, it } from "vitest";
import { actualyzeBaseUrl, endpointLabel, normalizeBaseUrl, normalizeTarget, validateApiKey } from "../src/endpoint.js";

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

	describe("when validating a full base URL", () => {
		it.each([
			["HTTPS://Actualyze.Example.COM:443/openai/v1/", "https://actualyze.example.com/openai/v1"],
			["https://actualyze.example.com:8443/openai/v1", "https://actualyze.example.com:8443/openai/v1"],
			["http://127.0.0.1:8080/openai/v1", "http://127.0.0.1:8080/openai/v1"],
			["http://localhost:8080/openai/v1//", "http://localhost:8080/openai/v1"],
			["http://[::1]:8080/openai/v1", "http://[::1]:8080/openai/v1"],
		])("normalizes %s", (value, expected) => {
			expect(normalizeBaseUrl(value)).toBe(expected);
		});

		it.each([
			["a bare host", "actualyze.example.com/openai/v1", /absolute https URL/u],
			["surrounding whitespace", " https://actualyze.example.com/openai/v1", /absolute https URL/u],
			["plain HTTP off this machine", "http://actualyze.example.com/openai/v1", /http only for localhost,/u],
			["plain HTTP to another loopback address", "http://127.0.0.2:8080/openai/v1", /http only for localhost,/u],
			["another scheme", "ftp://actualyze.example.com/openai/v1", /http only for localhost,/u],
			["credentials", "https://user:pass@actualyze.example.com/openai/v1", /credentials/u],
			["a query", "https://actualyze.example.com/openai/v1?team=a", /query or fragment/u],
			["a fragment", "https://actualyze.example.com/openai/v1#models", /query or fragment/u],
		])("rejects %s", (_case, value, message) => {
			expect(() => normalizeBaseUrl(value)).toThrow(message);
		});

		it("names an HTTPS endpoint by its host and a plain HTTP one by its origin", () => {
			expect(endpointLabel("https://actualyze.example.com:8443/openai/v1")).toBe("actualyze.example.com:8443");
			expect(endpointLabel("http://127.0.0.1:8080/openai/v1")).toBe("http://127.0.0.1:8080");
		});
	});

	it("validates visible-ASCII API keys without returning surrounding whitespace", () => {
		expect(validateApiKey("  secret-token  ")).toBe("secret-token");
		expect(() => validateApiKey("secret token")).toThrow(/visible-ASCII/u);
		expect(() => validateApiKey("\n\t")).toThrow(/visible-ASCII/u);
	});
});
