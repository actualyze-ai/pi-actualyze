import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Hermeticity: a developer's exported live-test credentials and own pi
// installation must never leak into the in-process suite. Individual tests
// that need ambient values stub them explicitly with vi.stubEnv. The opt-in
// live suite (npm run test:live) sets ACTUALYZE_LIVE_TEST=1 and the contract
// suite (npm run test:contract) sets ACTUALYZE_CONTRACT_TEST=1; both genuinely
// need the ambient credentials, so they are exempt.
if (process.env.ACTUALYZE_LIVE_TEST !== "1" && process.env.ACTUALYZE_CONTRACT_TEST !== "1") {
	delete process.env.ACTUALYZE_TARGET;
	delete process.env.ACTUALYZE_API_KEY;
	delete process.env.ACTUALYZE_BASE_URL;
	delete process.env.ACTUALYZE_OPENAI_BASE_URL;
	delete process.env.PI_OFFLINE;

	// The extension factory reads auth.json and models-store.json from pi's
	// agent dir on every load, so every load sees an empty agent dir unless a
	// test stubs PI_CODING_AGENT_DIR with its own.
	const agentDir = mkdtempSync(join(tmpdir(), "pi-actualyze-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	afterAll(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});
}
