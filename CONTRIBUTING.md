# Contributing to pi-actualyze

This document covers the development workflow, the architecture of the
provider, and the invariants that must not regress.

## Prerequisites

- Node.js 22.22.1 or newer for development, because the pre-commit hook's
  lint-staged requires it (CI runs 22 and 24; the published package itself
  supports 22.19.0 or newer)
- npm (ships with Node)
- A [pi](https://github.com/earendil-works/pi) checkout or installation of
  1.0.0 or newer if you want to exercise the extension end to end

## Setup

```bash
git clone git@github.com:actualyze-ai/pi-actualyze.git
cd pi-actualyze
npm install
npm run check
```

`npm install` also installs the git hooks (husky). `npm run check` runs the
complete offline gate: typecheck, lint, format check, tests, build, and a
dry-run pack inspection. It must pass before any push.

To load your checkout in pi without touching your pi settings:

```bash
pi --no-extensions -e .
```

## Development workflow

| Where                        | What runs                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pre-commit` hook            | Biome lint/format on staged files (lint-staged)                                                        |
| `pre-push` hook              | `npm run check`                                                                                        |
| CI (`ci.yml`)                | `npm ci`, `npm run check`, and `npm audit signatures` on Node 22 and 24, plus actionlint and zizmor    |
| CI (`codeql.yml`)            | CodeQL for JavaScript/TypeScript and the workflows, on every change and weekly                         |
| CI (`dependency-review.yml`) | Blocks pull requests that add vulnerable, denied, or disallowed-license dependencies                   |
| CI (`vuln-scan.yml`)         | Daily full-tree `npm audit`, `npm audit signatures`, and a provenance check of every published version |
| CI (`compat.yml`)            | Daily tests against pi's pinned, `latest`, and `next` releases; failures open a `compat` issue         |
| CI (`contract-tests.yml`)    | Daily `npm run test:contract` against a live endpoint from the `contract-tests` environment            |
| CI (`scorecard.yml`)         | OpenSSF Scorecard, weekly and on pushes to `main`                                                      |
| CI (`release.yml`)           | On `v*` tags: the release checks, then `npm publish` and a draft GitHub Release after approval         |
| CI (`finalize-release.yml`)  | Run by hand after the release: checks the npm version and the draft, then publishes the draft          |
| Never automatically          | Live tests (`npm run test:live`), which spend real credentials and money                               |

Every workflow is a thin caller of a reusable workflow in
[actualyze-ai/oss-workflows](https://github.com/actualyze-ai/oss-workflows), pinned
by commit SHA. Read that repository's README before changing a caller.

## Architecture

The package registers one dynamic `Provider<"openai-completions">` with pi.
Six small modules under `src/`:

| Module         | Responsibility                                                    |
| -------------- | ----------------------------------------------------------------- |
| `constants.ts` | Provider ID, env var and flag names, default target, limits       |
| `endpoint.ts`  | Target-label validation and canonical base URL construction       |
| `transport.ts` | Guarded fetch, retries, deadlines, bounded reads, redaction       |
| `catalog.ts`   | Fail-closed `/models` parsing and model conversion                |
| `client.ts`    | Thin composition: guarded fetch + `getJson` + `parseCatalog`      |
| `provider.ts`  | Auth hooks, refresh lifecycle, catalog state, stream guards       |
| `index.ts`     | Extension entry: `--actualyze-target` flag, provider registration |

Data flow for a catalog refresh:

```mermaid
flowchart LR
    piCore["pi refresh<br/>(2 phases)"] --> refresh["provider.refreshModels"]
    refresh --> config["resolve configuration<br/>(credential, env, last)"]
    config --> restore["restore stored catalog<br/>(baseUrl-scoped)"]
    restore --> fetch["guarded GET /models"]
    fetch --> parse["parseCatalog<br/>(fail-closed)"]
    parse --> publish["context.publish<br/>(generation-gated)"]
```

Key behaviors, each backed by tests:

- **Production by default** (`provider.ts`): login prompts only for the API
  key. When no stored credential pins a target, it comes from the
  `--actualyze-target` flag, then `ACTUALYZE_TARGET`, then `app`. Login never
  asks for a target.
- **Endpoint validation** (`endpoint.ts`): the target is exactly one ASCII
  DNS label. The base URL is always
  `https://<target>.actualyze.ai/openai/v1`. Test-only endpoints are
  injected through options, never through relaxed validation.
- **Guarded transport** (`transport.ts`): every request, including
  inference, goes through a fetch wrapper that requires HTTPS, the exact
  configured origin, and paths under `/openai/v1`; rejects all redirects
  (301/302/303/307/308); and redacts the API key and authorization header
  from every error path, including provider error bodies and headers.
- **Fail-closed catalog** (`catalog.ts`): one malformed, duplicate, or
  unsafe entry rejects the whole generation. The previous generation stays
  intact. There is no partial publication.
- **Sentinels, not guesses**: missing limits become documented pi schema
  fallbacks (128,000 context / 16,384 output). All costs are `0`, an
  unknown-price sentinel, until Actualyze confirms currency and units.
  PDF/audio/video advertisements are not mapped to pi modalities.
- **Target-scoped cache** (`provider.ts`): a persisted catalog is restored
  only when every model's `baseUrl` matches the currently resolved target.
  Mismatches are discarded, not displayed.
- **Stream guards** (`provider.ts`): before dispatch, a request is refused
  when the catalog attributes the model ID to another target, when the
  model object's base URL does not match the active target, or when the ID
  is absent from a non-empty discovered catalog.

## Subtleties worth knowing before you edit `provider.ts`

Understand these before changing the refresh or auth code.

**pi refreshes in two phases.** Phase 1 is cache-only and runs with the
_stored_ credential, which is `undefined` for users configured purely via
environment variables. Phase 2 resolves auth (calling the provider's
`resolve()`) and allows network. `refreshConfiguration` therefore resolves
field by field: stored credential first, then the ambient sources (the
`--actualyze-target` flag and `process.env`, with the target defaulting to
`app`), then the last resolved configuration. Without the env fallback,
ambient-only users would never restore a cached catalog offline.

**Read the target flag lazily.** pi parses extension flags after the
extension factory returns, so `index.ts` passes a getter, not a value, and
the provider calls it on every login, check, resolve, and refresh. pi also
runs its startup cache-only refresh before it applies flag values, so while
`getFlag()` is still undefined the getter falls back to pi's own `parseArgs`
over `process.argv`. Without that fallback, a key-only environment started
with `--actualyze-target` would resolve `app` at startup and delete the
selected target's cached catalog. The getter also catches `getFlag()`
throwing on a stale extension runtime (after `/reload`), because the old
provider can stay registered and its `check()` must not throw.

The fallback reads the CLI's argv, so it does not see flag values that an
SDK host passes through `extensionFlagValues`; those still arrive after the
startup refresh. SDK hosts should select a target with `ACTUALYZE_TARGET` or
the `target` option of `createActualyzeProvider` instead.

**`check()` must never throw.** pi runs every provider's availability check
in one `Promise.all`; a single throwing `check()` blanks the model picker
for all providers. Validation errors from stored credentials are caught in
`check()` and surfaced later through `resolve()`, which fails only the
request that needs the credential.

**pi rewrites `model.baseUrl` before calling `stream()`.** The runtime
replaces the model's base URL with the resolved auth URL, so a naive
`model.baseUrl !== activeBaseUrl` comparison can never fire through the
real pipeline. The catalog-attribution check (look up the ID in the
in-memory catalog) is the guard that actually works; the direct comparison
is kept for direct provider use only.

**`pendingLoginCatalog` is cleared only by a matching publish.** Login
installs the fetched catalog in memory and stages it for persistence. A
refresh holding a stale credential can still be in flight when login
completes, and pi does not supersede it until the post-login credential
sync. If the mismatch path cleared the pending catalog, that stale refresh
could destroy a fresh login's catalog. Instead, mismatched refreshes fall
through and publish whatever is correct for their configuration, and the
pending catalog survives until a refresh with the matching credential
consumes it. The tradeoff: after a genuine target switch the pending entry
is retained as dead weight, and if auth later returns to the exact pending
target and key without a new login, the login-time snapshot is republished
once before the next network refresh replaces it.

**Generation gating is the concurrency backbone.** `context.publish()`
runs its `update` callback only when the calling refresh is still the
current generation. Any state change that must not be applied by a
superseded refresh belongs inside `update`, not before the publish call.

## Caveats

- **`--list-models` race (pi 0.84.2).** The CLI's availability lookup can
  run before the asynchronous refresh triggered by extension registration
  completes, printing no dynamic models. Interactive `/model` is reliable.
- **Costs are always zero.** This is an unknown-price sentinel, not free
  inference. Actualyze advertises `cost.input`, `cost.output`,
  `cost.cache_read`, and `cost.cache_write` without declaring currency or
  units, and pi interprets cost fields as USD per million tokens.
- **Advisory capability flags.** `streaming: false` and `tool_use: false`
  in the Actualyze catalog are advisory. Models are never filtered on these
  flags; a model-specific incompatibility belongs in an explicit
  compatibility rule, not a catalog filter.
- **`models.json` entries are not supported.** Manually defined Actualyze
  models are refused by the stream guard because the provider's discovered
  catalog is authoritative.
- **The prepare script tolerates a missing husky.** `pi install git:...`
  runs `npm install --omit=dev` in the clone, which still executes
  `prepare`. The script swallows only `ERR_MODULE_NOT_FOUND` so hook
  installation is skipped in production installs but real failures still
  surface.

## Code style

- TypeScript strict mode; no `any`.
- Biome for lint and formatting (`biome.json`); tabs, 120-column lines.
- `npm run format` fixes formatting; `npm run lint` checks lint rules.

## Testing

```bash
npm test            # offline suite (excludes test/live.test.ts)
npm run test:live   # explicit, credential-gated live tests
```

Tests derive from decision logic and error paths, not coverage targets.
`test/models-lifecycle.test.ts` drives pi's real `ModelRuntime` rather than
hand-rolled contexts; prefer that pattern for lifecycle behavior, because
some behavior (pi rewriting auth before `stream()`, two-phase refresh
ordering) is only reachable through the real runtime. The offline suite
must stay hermetic: `test/setup.ts` clears ambient `ACTUALYZE_*` variables
so a developer's exported live credentials cannot leak into assertions.

Security-sensitive paths have dedicated tests: redirect blocking with
proof that no second request carries credentials, redaction of keys from
every error path, a secret scan of the packed artifact, and hostile
catalog inputs (control characters, dot segments, oversized and
non-encodable IDs).

## Commit messages

Conventional Commits: `<type>(scope): <summary>` with an imperative,
specific summary and no trailing period. Add a body with bullet points when
the summary alone is ambiguous; wrap body lines at 72 characters.

## Pull requests

- `npm run check` must pass locally (the pre-push hook enforces this) and
  in CI on both Node versions.
- Changes to the refresh lifecycle, auth hooks, transport guards, or
  catalog validation need tests that fail without the change.
- Never include credentials, live API captures, or `.env` files. The pack
  test scans the published file list for secret-shaped content, but that is
  a backstop, not permission.
- Public contract changes (exported symbols, CLI-visible behavior,
  configuration) must update the README and this guide.
