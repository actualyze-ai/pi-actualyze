// Hermeticity: a developer's exported live-test credentials must never leak
// into the in-process suite. Individual tests that need ambient values stub
// them explicitly with vi.stubEnv. The opt-in live suite (npm run test:live)
// sets ACTUALYZE_LIVE_TEST=1 and the contract suite (npm run test:contract)
// sets ACTUALYZE_CONTRACT_TEST=1; both genuinely need the ambient
// credentials, so they are exempt.
if (process.env.ACTUALYZE_LIVE_TEST !== "1" && process.env.ACTUALYZE_CONTRACT_TEST !== "1") {
	delete process.env.ACTUALYZE_TARGET;
	delete process.env.ACTUALYZE_API_KEY;
	delete process.env.ACTUALYZE_BASE_URL;
}
