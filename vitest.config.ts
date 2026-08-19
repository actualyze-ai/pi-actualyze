import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The default exclusions (node_modules, dist, ...) apply; live-test
		// exclusion stays on the CLI flag in the npm test script, because a
		// config-level exclude would REPLACE the defaults instead of extending
		// them.
		setupFiles: ["test/setup.ts"],
		unstubEnvs: true,
	},
});
