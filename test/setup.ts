// Hermeticity: a developer's exported live-test credentials must never leak
// into the in-process suite. Individual tests that need ambient values stub
// them explicitly with vi.stubEnv. The opt-in live suite (npm run test:live)
// sets ACTUALYZE_LIVE_TEST=1 and genuinely needs the ambient credentials, so
// it is exempt.
if (process.env.ACTUALYZE_LIVE_TEST !== "1") {
	delete process.env.ACTUALYZE_TARGET;
	delete process.env.ACTUALYZE_API_KEY;
}
