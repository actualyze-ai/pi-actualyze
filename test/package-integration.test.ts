import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageManifest from "../package.json";
import { parseCatalog } from "../src/catalog.js";
import { modelEntry } from "./fixtures.js";

const projectRoot = resolve(import.meta.dirname, "..");
const piCli = resolve(projectRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

function piArgs(args: string[]): string[] {
	return [piCli, "--no-extensions", "-e", resolve(projectRoot, "src/index.ts"), ...args];
}

function piEnvironment(agentDir: string, env: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		ACTUALYZE_TARGET: "",
		ACTUALYZE_API_KEY: "",
		ACTUALYZE_OPENAI_BASE_URL: "",
		NO_COLOR: "1",
		...env,
	};
}

/** Run the real pi CLI with only this extension loaded and an isolated agent dir. */
function runPi(
	args: string[],
	options: { env?: Record<string, string>; modelsStore?: unknown } = {},
): SpawnSyncReturns<string> {
	const agentDir = mkdtempSync(resolve(tmpdir(), "pi-actualyze-integration-"));
	try {
		if (options.modelsStore !== undefined) {
			writeFileSync(resolve(agentDir, "models-store.json"), JSON.stringify(options.modelsStore));
		}
		return spawnSync(process.execPath, piArgs(args), {
			cwd: projectRoot,
			encoding: "utf8",
			input: "",
			env: piEnvironment(agentDir, options.env),
			timeout: 30_000,
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

interface PiRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run the real pi CLI without blocking this process, so a server in the test
 * can answer it. pi's stdin closes once `closeStdin` settles; RPC mode runs
 * until then.
 */
async function runPiAsync(
	args: string[],
	agentDir: string,
	env: Record<string, string>,
	closeStdin: Promise<unknown> = Promise.resolve(),
): Promise<PiRun> {
	const child = spawn(process.execPath, piArgs(args), { cwd: projectRoot, env: piEnvironment(agentDir, env) });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const end = (): void => {
		child.stdin.end();
	};
	closeStdin.then(end, end);
	const timeout = setTimeout(() => child.kill(), 30_000);
	const status = await new Promise<number | null>((done) => child.on("close", (code) => done(code)));
	clearTimeout(timeout);
	return { status, stdout, stderr };
}

function completionStream(text: string): string {
	const chunk = (choice: Record<string, unknown>, usage?: Record<string, number>): string =>
		`data: ${JSON.stringify({
			id: "completion-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "mock-model",
			choices: [{ index: 0, ...choice }],
			...(usage ? { usage } : {}),
		})}\n\n`;
	return `${chunk({ delta: { role: "assistant", content: text }, finish_reason: null })}${chunk(
		{ delta: {}, finish_reason: "stop" },
		{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	)}data: [DONE]\n\n`;
}

interface LoopbackEndpoint {
	origin: string;
	/** `METHOD path authorization` for every request it answered. */
	requests: string[];
	/** The `host:port` of every CONNECT it refused as a proxy. */
	tunnels: string[];
	close(): Promise<void>;
}

/**
 * A loopback Actualyze endpoint serving one model and one streamed reply. It
 * also acts as the HTTPS proxy: it records and refuses each CONNECT, so a
 * request meant for another host shows up here without leaving the machine.
 */
async function startEndpoint(): Promise<LoopbackEndpoint> {
	const requests: string[] = [];
	const tunnels: string[] = [];
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
		request.resume();
		request.on("end", () => {
			if (request.method === "GET" && request.url === "/openai/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [modelEntry("mock-model")] }));
			} else if (request.method === "POST" && request.url === "/openai/v1/chat/completions") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completionStream("FIRST-RUN-OK"));
			} else {
				response.writeHead(404).end();
			}
		});
	});
	server.on("connect", (request, socket) => {
		tunnels.push(request.url ?? "");
		socket.destroy();
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		requests,
		tunnels,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}

/** Resolves when `condition` holds or `timeoutMs` passes, whichever is first. */
async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) {
		await new Promise((done) => setTimeout(done, 50));
	}
}

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
		expect(readFileSync(piCli, "utf8").length).toBeGreaterThan(0);
		const result = runPi(["--list-models"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).not.toMatch(/failed to load|extension error/iu);
	});

	it("accepts --actualyze-target where pi rejects an unregistered flag", () => {
		// --list-models exits before pi validates extension flags, so use print
		// mode, which reports flag diagnostics before it looks for a model. The
		// unregistered control proves this invocation does validate flags.
		const printArgs = ["--offline", "--no-session", "-p", "hi"];
		const accepted = runPi([...printArgs, "--actualyze-target", "staging"]);
		expect(accepted.stderr).not.toMatch(/Unknown option|requires a value/u);
		// pi reads a `-` after a space as another option, so `-` needs the `=` form.
		const none = runPi([...printArgs, "--actualyze-target=-"]);
		expect(none.stderr).not.toMatch(/Unknown option|requires a value/u);
		const rejected = runPi([...printArgs, "--actualyze-unregistered", "staging"]);
		expect(rejected.stderr).toMatch(/Unknown option: --actualyze-unregistered/u);
	});

	// pi runs its startup cache-only refresh before it applies extension flag
	// values. Without the argv fallback in index.ts the provider would see no
	// target there, so it would restore and list nothing.
	it("restores the --actualyze-target cache at startup for a key-only environment", () => {
		const cached = parseCatalog({ data: [modelEntry("staging-cached")] }, "https://staging.actualyze.ai/openai/v1");
		const result = runPi(["--offline", "--actualyze-target", "staging", "--list-models"], {
			env: { ACTUALYZE_API_KEY: "test-key" },
			modelsStore: { actualyze: { models: cached } },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/staging-cached/u);
	});

	it("selects no target with --actualyze-target=- over ACTUALYZE_TARGET", () => {
		const cached = parseCatalog({ data: [modelEntry("staging-cached")] }, "https://staging.actualyze.ai/openai/v1");
		const options = {
			env: { ACTUALYZE_API_KEY: "test-key", ACTUALYZE_TARGET: "staging" },
			modelsStore: { actualyze: { models: cached } },
		};
		const control = runPi(["--offline", "--list-models"], options);
		expect(control.status, control.stderr).toBe(0);
		expect(control.stdout).toMatch(/staging-cached/u);
		const none = runPi(["--offline", "--actualyze-target=-", "--list-models"], options);
		expect(none.status, none.stderr).toBe(0);
		expect(none.stdout).not.toMatch(/staging-cached/u);
	});

	describe("against a loopback endpoint", () => {
		const direct = { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NO_PROXY: "127.0.0.1" };

		// pi resolves --provider and --model before any network refresh, so
		// this run works only if the extension fetched the catalog at load.
		it("answers a first --provider actualyze --model run with nothing cached", async () => {
			const endpoint = await startEndpoint();
			const agentDir = mkdtempSync(resolve(tmpdir(), "pi-actualyze-integration-"));
			try {
				const result = await runPiAsync(
					["--no-session", "--provider", "actualyze", "--model", "mock-model", "-p", "hi"],
					agentDir,
					{ ...direct, ACTUALYZE_API_KEY: "run-key", ACTUALYZE_OPENAI_BASE_URL: `${endpoint.origin}/openai/v1` },
				);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("FIRST-RUN-OK");
				expect(endpoint.requests).toEqual([
					"GET /openai/v1/models Bearer run-key",
					"POST /openai/v1/chat/completions Bearer run-key",
				]);
				const stored = JSON.parse(readFileSync(resolve(agentDir, "models-store.json"), "utf8")) as {
					actualyze?: { models: Array<{ id: string; baseUrl: string }> };
				};
				expect(stored.actualyze?.models).toMatchObject([{ id: "mock-model", baseUrl: `${endpoint.origin}/openai/v1` }]);
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
				await endpoint.close();
			}
		}, 60_000);

		// pi's global dispatcher sends plain HTTP to HTTP_PROXY unless NO_PROXY
		// lists the host, so the proxy would receive the key in clear text if
		// the extension's loopback requests went through it.
		it("sends a loopback endpoint's key directly while HTTP_PROXY is set", async () => {
			const endpoint = await startEndpoint();
			const proxy = await startEndpoint();
			const agentDir = mkdtempSync(resolve(tmpdir(), "pi-actualyze-integration-"));
			try {
				const result = await runPiAsync(
					["--no-session", "--provider", "actualyze", "--model", "mock-model", "-p", "hi"],
					agentDir,
					{
						HTTP_PROXY: proxy.origin,
						http_proxy: proxy.origin,
						HTTPS_PROXY: "",
						https_proxy: "",
						NO_PROXY: "",
						no_proxy: "",
						PI_SKIP_VERSION_CHECK: "1",
						ACTUALYZE_API_KEY: "run-key",
						ACTUALYZE_OPENAI_BASE_URL: `${endpoint.origin}/openai/v1`,
					},
				);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("FIRST-RUN-OK");
				expect(endpoint.requests).toEqual([
					"GET /openai/v1/models Bearer run-key",
					"POST /openai/v1/chat/completions Bearer run-key",
				]);
				expect(proxy.requests).toEqual([]);
				expect(proxy.tunnels).toEqual([]);
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
				await Promise.all([endpoint.close(), proxy.close()]);
			}
		}, 60_000);

		it("answers a --model run from pi's cache without fetching the catalog at load", async () => {
			const endpoint = await startEndpoint();
			const baseUrl = `${endpoint.origin}/openai/v1`;
			const agentDir = mkdtempSync(resolve(tmpdir(), "pi-actualyze-integration-"));
			try {
				const cached = parseCatalog({ data: [modelEntry("mock-model")] }, baseUrl);
				writeFileSync(resolve(agentDir, "models-store.json"), JSON.stringify({ actualyze: { models: cached } }));
				const result = await runPiAsync(
					["--no-session", "--provider", "actualyze", "--model", "mock-model", "-p", "hi"],
					agentDir,
					{ ...direct, ACTUALYZE_API_KEY: "run-key", ACTUALYZE_OPENAI_BASE_URL: baseUrl },
				);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("FIRST-RUN-OK");
				expect(endpoint.requests).toEqual(["POST /openai/v1/chat/completions Bearer run-key"]);
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
				await endpoint.close();
			}
		}, 60_000);

		// RPC mode refreshes catalogs from the network right after startup.
		// Every HTTPS request goes through the endpoint as a proxy, so a key
		// sent to any *.actualyze.ai host shows up as a refused CONNECT.
		it("sends a key from an environment that names no endpoint nowhere at startup", async () => {
			const endpoint = await startEndpoint();
			const viaProxy = {
				HTTP_PROXY: "",
				http_proxy: "",
				HTTPS_PROXY: endpoint.origin,
				https_proxy: endpoint.origin,
				NO_PROXY: "",
				no_proxy: "",
				PI_SKIP_VERSION_CHECK: "1",
			};
			const rpc = ["--mode", "rpc", "--no-session"];
			const agentDirs = [0, 1].map(() => mkdtempSync(resolve(tmpdir(), "pi-actualyze-integration-")));
			const actualyzeTunnels = (): string[] =>
				endpoint.tunnels.filter((tunnel) => tunnel.endsWith(".actualyze.ai:443"));
			try {
				// Control: with a target, the startup refresh reaches the proxy.
				const started = Date.now();
				await runPiAsync(
					rpc,
					agentDirs[0] ?? "",
					{ ...viaProxy, ACTUALYZE_API_KEY: "run-key", ACTUALYZE_TARGET: "app" },
					until(() => actualyzeTunnels().length > 0, 20_000),
				);
				expect(actualyzeTunnels()).toContain("app.actualyze.ai:443");
				const window = Math.max(3_000, 2 * (Date.now() - started));

				endpoint.tunnels.length = 0;
				await runPiAsync(
					rpc,
					agentDirs[1] ?? "",
					{ ...viaProxy, ACTUALYZE_API_KEY: "run-key" },
					new Promise((done) => setTimeout(done, window)),
				);
				expect(actualyzeTunnels()).toEqual([]);
			} finally {
				for (const agentDir of agentDirs) rmSync(agentDir, { recursive: true, force: true });
				await endpoint.close();
			}
		}, 90_000);
	});
});
