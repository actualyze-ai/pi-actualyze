import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageManifest from "../package.json";

const projectRoot = resolve(import.meta.dirname, "..");

describe("pi package integration", () => {
	it("declares only the native extension entry and publish-safe files", () => {
		expect(packageManifest.pi.extensions).toEqual(["./src/index.ts"]);
		expect(packageManifest.files).toEqual(expect.arrayContaining(["src", "README.md"]));
		expect(packageManifest.files).not.toContain("test");
		expect(packageManifest.files).not.toContain(".env.example");
	});

	it("packs no test fixtures, env files, or secret-shaped content", () => {
		// Run npm through its JS entry point (like the pi CLI spawn below) so the
		// spawn works on Windows, where "npm" is a .cmd shim spawnSync cannot
		// execute directly. npm_execpath is set whenever the suite runs under npm.
		const npmCli = process.env.npm_execpath;
		const pack = spawnSync(
			npmCli ? process.execPath : "npm",
			npmCli ? [npmCli, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"],
			{
				cwd: projectRoot,
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(pack.status, pack.stderr).toBe(0);
		const [report] = JSON.parse(pack.stdout) as [{ files: Array<{ path: string }> }];
		const paths = report.files.map((file) => file.path);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(path).not.toMatch(/^test\//u);
			expect(path).not.toMatch(/(^|\/)\.env/u);
			expect(path).not.toMatch(/fixtures/u);
			expect(path).not.toMatch(/^docs(\/|$)/u);
		}

		// The README documents ACTUALYZE_API_KEY='your-api-key'; only flag
		// secret-length values so the placeholder does not trip the scan.
		const secretPatterns = [
			/sk-[A-Za-z0-9]{20,}/u,
			/Bearer [A-Za-z0-9_-]{20,}/u,
			/ACTUALYZE_API_KEY=['"]?[A-Za-z0-9_-]{20,}/u,
		];
		for (const path of paths) {
			const content = readFileSync(resolve(projectRoot, path), "utf8");
			for (const pattern of secretPatterns) {
				expect(content, `${path} matches ${pattern}`).not.toMatch(pattern);
			}
		}
	});

	it("loads through an isolated pi CLI process", () => {
		const agentDir = mkdtempSync(resolve(tmpdir(), "pi-actualyze-integration-"));
		try {
			const piCli = resolve(projectRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
			expect(readFileSync(piCli, "utf8").length).toBeGreaterThan(0);
			const result = spawnSync(
				process.execPath,
				[piCli, "--no-extensions", "-e", resolve(projectRoot, "src/index.ts"), "--list-models"],
				{
					cwd: projectRoot,
					encoding: "utf8",
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: agentDir,
						ACTUALYZE_TARGET: "",
						ACTUALYZE_API_KEY: "",
						NO_COLOR: "1",
					},
					timeout: 30_000,
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).not.toMatch(/failed to load|extension error/iu);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
