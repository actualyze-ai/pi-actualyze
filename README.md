# pi-actualyze

[![CI](https://github.com/actualyze-ai/pi-actualyze/actions/workflows/ci.yml/badge.svg)](https://github.com/actualyze-ai/pi-actualyze/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-actualyze.svg)](https://www.npmjs.com/package/pi-actualyze)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js >= 22.19](https://img.shields.io/badge/Node.js-%3E%3D22.19-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)

A native [pi](https://github.com/earendil-works/pi) provider package for
[Actualyze](https://actualyze.ai), the AI platform built by Actualyze AI.
Log in with an Actualyze API key, and the provider discovers every model
advertised by Actualyze automatically. No `models.json`, copied model
IDs, or per-model configuration required.

## Quick Start

Install from npm:

```bash
pi install npm:pi-actualyze
```

Start pi and authenticate:

```text
/login actualyze
```

Enter your Actualyze API key when asked. Login connects to the production
endpoint, `https://app.actualyze.ai`, and does not ask about environments.

Login validates the credentials, downloads the complete model catalog, and makes
the discovered models available immediately. Open pi's model selector:

```text
/model
```

Select any model under the `actualyze` provider.

Upgrading from 2.x? A key set only through `ACTUALYZE_API_KEY` now needs a
target as well; see [Upgrading to 3.0](#upgrading-to-30).

## The Problem

An Actualyze deployment can expose a changing catalog of direct models, routed
aliases, and workload-oriented model groups. Hard-coding that catalog in pi would
be incomplete as soon as Actualyze adds, removes, or updates an entry. Requiring
users to copy each model into `models.json` would also duplicate metadata that the
Actualyze API already publishes, including context limits, output limits,
modalities, reasoning support, and caching information.

**pi-actualyze** makes Actualyze a native dynamic pi provider. The API key is the
only user configuration. The package queries Actualyze directly,
validates the complete catalog as one atomic generation, converts every valid
entry into a pi model, and routes inference through pi's native OpenAI Chat
Completions implementation.

## How It Works

The provider owns the complete lifecycle:

1. **Configuration:** `/login actualyze` asks only for an API key and logs in
   to production (`app`) unless another endpoint is selected. A target label
   always maps to the fixed endpoint `https://<target>.actualyze.ai/openai/v1`,
   and a launcher can name any other Actualyze environment with
   `ACTUALYZE_OPENAI_BASE_URL`. A key from the environment is sent only to an
   endpoint the environment names.

2. **Credential validation:** Before pi saves anything, the provider sends an
   authenticated `GET /models` request through a guarded transport. Invalid
   credentials, malformed responses, and unsafe catalog entries fail the login.

3. **Automatic discovery:** The OpenAI-style model list is authoritative for
   membership. Every unique, safely representable ID becomes a pi model. The
   provider does not filter entries by owner, price, or advisory capability flags.

4. **Atomic publication:** A generation is published only when the complete list
   validates. One malformed or duplicate entry rejects the new generation instead
   of silently presenting a partial catalog. An existing valid generation remains
   intact when refresh fails.

5. **Endpoint-scoped persistence:** Pi can restore a cached catalog on startup only
   when every cached model belongs to `actualyze` and points at the active endpoint's
   exact base URL. Switching endpoints discards mismatched cached and in-memory
   catalogs.

6. **Native inference:** Requests use pi's OpenAI Chat Completions adapter with a
   conservative, explicit compatibility profile. Text, images, reasoning, streamed
   usage, function tools, and tool-result continuation use pi's normal model
   pipeline.

7. **Routed aliases:** Pi retains the requested Actualyze catalog ID as the model
   identity. If Actualyze reports the selected upstream model in stream chunks, pi
   records it separately as `responseModel`.

## Installation

### npm (recommended)

```bash
pi install npm:pi-actualyze
```

To pin a version:

```bash
pi install npm:pi-actualyze@3.0.0
```

Uninstall with:

```bash
pi remove npm:pi-actualyze
```

### GitHub

To track the repository directly instead of npm releases:

```bash
pi install git:github.com/actualyze-ai/pi-actualyze
```

To pin a tag or commit:

```bash
pi install git:github.com/actualyze-ai/pi-actualyze@<tag-or-commit>
```

Git installations are managed by pi. Use `pi update --extensions` to reconcile
unpinned package installations and `pi remove` to uninstall:

```bash
pi remove git:github.com/actualyze-ai/pi-actualyze
```

### Local checkout

For development, install the checkout by absolute path:

```bash
git clone git@github.com:actualyze-ai/pi-actualyze.git
cd pi-actualyze
npm install
npm run check
pi install "$PWD"
```

A local-path installation references the directory in place. Source edits are
picked up the next time pi starts; no copy is made into pi's package directory.

To try the extension for one process without changing pi settings:

```bash
pi --no-extensions -e .
```

### Requirements

- pi `1.0.0` or newer
- Node.js `22.19.0` or newer for development
- Network access to `app.actualyze.ai` (or the selected target or base URL)
- An Actualyze API key valid for that endpoint

## Configuration

### Interactive Login

Run:

```text
/login actualyze
```

The flow asks for one value, your API key. The prompt names the host it will
authenticate against:

```text
Actualyze API key for app.actualyze.ai
```

Login fetches and validates the catalog before returning the credential to pi. A
failed validation stores nothing.

### Selecting Another Environment

Most users never need this section. To use a target other than production,
select it before logging in with either the `--actualyze-target` flag or the
`ACTUALYZE_TARGET` environment variable:

```bash
pi --actualyze-target staging
```

```text
/login actualyze
```

The endpoint is resolved in this order:

| Priority | Source                                                        | Example                         |
| -------- | ------------------------------------------------------------- | ------------------------------- |
| 1        | Saved credential's endpoint                                   | set by the last `/login`        |
| 2        | The target with `ACTUALYZE_OPENAI_BASE_URL` (they must agree) | `pi --actualyze-target staging` |
| 3        | Production (`app`), for `/login` only                         | `/login actualyze`              |

The target is the `--actualyze-target` flag when it is set, else
`ACTUALYZE_TARGET`. A target or `ACTUALYZE_OPENAI_BASE_URL` alone names the
endpoint (see [below](#another-actualyze-environment-by-url) for the base URL).
They can both be set only when they name the same endpoint; when they disagree,
the provider stays unavailable and sends nothing.

The target `-` selects no `*.actualyze.ai` target, which leaves the choice to
`ACTUALYZE_OPENAI_BASE_URL`. Set it as `ACTUALYZE_TARGET=-` or
`--actualyze-target=-`: pi reads a `-` after a space as an option of its own and
exits with `Unknown option: -`. A label works either way, as in
`--actualyze-target staging`.

Production is a default only for `/login`, whose prompt names the host you are
entering a key for. A key from `ACTUALYZE_API_KEY` is never sent to production
unless a target or base URL names it: with only the key set, the provider is
unavailable.

At login there is no saved credential yet, so the flag, the environment
variables, or the production default decide. A saved credential keeps the
endpoint it was created with; to move a saved login to another environment,
start pi with the flag and run `/login actualyze` again.

The target `staging` resolves only to:

```text
https://staging.actualyze.ai/openai/v1
```

Target labels may contain ASCII letters, digits, and internal hyphens. The
provider rejects dots, schemes, paths, ports, whitespace, Unicode lookalikes,
control characters, and labels longer than 63 characters. Uppercase ASCII letters
are normalized to lowercase. Login rejects an invalid label before asking for
the API key.

### Another Actualyze Environment by URL

A tool that launches pi for one run against an Actualyze environment outside
`*.actualyze.ai` sets `ACTUALYZE_OPENAI_BASE_URL` to that environment's OpenAI
base URL, for example `https://actualyze.example.com/openai/v1`, together with
the run's key in `ACTUALYZE_API_KEY`. The provider then discovers models and
sends inference there, and nowhere else.

The value must be an absolute `https` URL without a user name, password, query,
or fragment. Plain `http` is accepted only for `localhost`, `127.0.0.1`, and
`[::1]`, such as a local Actualyze stack. A value that breaks these rules makes
the provider unavailable instead of being ignored, because the key set beside it
belongs to that endpoint. `/login actualyze` uses the variable too when it is
set, and the saved credential keeps the base URL.

### Environment Configuration

For non-interactive authentication, set the API key and the endpoint before
starting pi:

```bash
export ACTUALYZE_API_KEY='your-api-key'
export ACTUALYZE_TARGET=app
pi
```

| Variable                    | Required                                  | Description                                                                          |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `ACTUALYZE_API_KEY`         | Yes                                       | API key for the endpoint                                                             |
| `ACTUALYZE_TARGET`          | Unless `ACTUALYZE_OPENAI_BASE_URL` is set | DNS label, such as `app` for production; `-` selects none; `--actualyze-target` wins |
| `ACTUALYZE_OPENAI_BASE_URL` | Unless a target is set                    | Full OpenAI base URL of an Actualyze environment                                     |

Stored credential fields take precedence over the corresponding environment
variables. Invalid ambient configuration is treated as unavailable authentication.
Invalid stored configuration also makes the provider unavailable at availability
check time (so one corrupt credential cannot blank the model picker for every
provider); the underlying validation error surfaces when a request or refresh
resolves the credential.

### Credential Storage and Logout

Pi stores the API key in its provider credential store and stores only the
non-secret endpoint in credential metadata: the target, or
`ACTUALYZE_OPENAI_BASE_URL` for a login made with that variable set. A
production login looks like this:

```json
{
  "type": "api_key",
  "key": "<secret>",
  "env": {
    "ACTUALYZE_TARGET": "app"
  }
}
```

Remove the saved credential with:

```text
/logout actualyze
```

After logout, Actualyze models are unavailable even if an in-memory catalog still
exists. Environment variables can still provide authentication if they remain set.

## Automatic Model Discovery

The provider requests:

```http
GET <base-url>/models
Authorization: Bearer <api-key>
```

The base URL is `https://<target>.actualyze.ai/openai/v1` for a target, or the
value of `ACTUALYZE_OPENAI_BASE_URL`.

The list response, not a bundled static file, is authoritative for model membership.
The provider registers exactly one model for every unique valid list ID.

### Catalog Validation

A new generation is rejected atomically when:

- the response is not JSON;
- the envelope is not an object with a `data` array;
- a claimed model lacks a non-empty string ID;
- model IDs are duplicated;
- an ID is a dot segment, oversized, not URL-encodable, or contains unsafe terminal
  or bidirectional control characters; or
- required catalog structure cannot be represented safely.

The provider does not request individual model details. The list endpoint already
advertises the metadata pi needs, and a single request keeps refresh within pi's
interactive deadline.

### Refresh and Cache Behavior

- Login installs the validated catalog in memory immediately.
- Normal refresh fetches a complete new `/models` generation.
- The aggregate catalog request budget is 10 seconds.
- Only rate limits and transient 5xx responses are retried.
- Valid `Retry-After` values are honored only when they fit the remaining budget.
- Cancellation stops active fetches, response reads, and retry delays.
- Failed refresh never replaces a previously accepted generation.
- A cached generation is restored only for the exact active base URL.
- pi resolves `--provider actualyze --model <id>` (or `--model actualyze/<id>`)
  before its own network refresh. When the environment names the key and the
  endpoint, and pi's cache has no catalog for that endpoint listing `<id>`, a
  run started that way fetches the catalog while pi loads the extension. The
  first run then works with nothing cached, and the catalog is stored for later
  runs. Until the fetch ends, pi waits before it starts, for at most the
  10-second catalog budget when the endpoint does not answer. A model pattern
  that is not an exact ID, such as one with a `:high` thinking suffix, always
  fetches. `--offline` skips the fetch.
- Same-target key rotation persists the newly validated login catalog instead of
  restoring the previous key's catalog.

## Model Metadata

Actualyze model advertisements are mapped into pi as follows:

| Actualyze field                     | pi field        | Behavior                                  |
| ----------------------------------- | --------------- | ----------------------------------------- |
| `id`                                | `id`, `name`    | Preserved exactly after safety validation |
| `context_window`                    | `contextWindow` | Preferred positive limit                  |
| `max_model_len`                     | `contextWindow` | Fallback when `context_window` is absent  |
| `max_output_tokens`                 | `maxTokens`     | Positive output limit                     |
| `modalities.input` includes `image` | `input`         | Enables image input                       |
| `capabilities.thinking`             | `reasoning`     | Enables reasoning when true               |
| `capabilities.thinking_adaptive`    | `reasoning`     | Also enables reasoning when true          |
| `cost`                              | `cost`          | Mapped as an estimate; see below          |

### Missing Limits

Pi requires numeric context and output limits. When Actualyze advertises no
positive value, the provider uses compatibility sentinels:

- context window: `128,000` tokens
- maximum output: `16,384` tokens

These values satisfy pi's model schema; they are not claims about an undisclosed
upstream limit.

When a model's real limits are smaller, pi compacts the conversation only after
a request fails with a context-overflow error, and it keeps asking for 16,384
output tokens. A model with a small context window or output limit can keep
failing. Set the real limits with pi's `modelOverrides` in `models.json`, which
lives in pi's agent directory (`~/.pi/agent/models.json` by default):

```json
{
  "providers": {
    "actualyze": {
      "modelOverrides": {
        "<model id>": { "contextWindow": 32000, "maxTokens": 4096 }
      }
    }
  }
}
```

Use the model id exactly as `/model` shows it. Overrides apply on top of the
discovered catalog and survive catalog refreshes. Only `modelOverrides` is
supported for Actualyze models; `models` entries are not (see
[Security](#security)).

While pi has no Actualyze model list loaded, for example after switching to a
target that lists no models, a `providers.actualyze` entry in `models.json` makes
pi send a request for a model it already holds through its own OpenAI client
instead of this provider. Such a request still goes to the active endpoint with
the active key, but without the guarded transport, the endpoint checks, or the
attribution header. Load the list with `/login actualyze` or interactive pi
before relying on an override.

### Pricing

Actualyze lists each model's cost in US dollars per million tokens, the unit pi
uses, and the provider maps it into pi's cost fields:

- `cost.input` and `cost.output` become pi's input and output rates.
- `cost.cache_read` and `cost.cache_write` become pi's cache rates. When the
  listing omits one, the provider estimates it from the input rate: the input
  rate itself for cache reads, and 1.25 times the input rate for cache writes.
- A malformed `input` or `output` figure becomes `0` for that field only. A
  malformed cache rate is estimated the same way as a missing one.

When Actualyze lists no cost for a model, all of its cost fields are `0`, an
**unknown-price sentinel**. Zero does not mean inference is free.

The cost pi shows is an estimate. Each listed rate is the highest among the
routes your key can reach, so a Virtual Model or Model Group whose members are
priced differently can read high. Actualyze's own usage metering is the record of
what a request cost.

### Modalities

Pi represents text and image input metadata. Actualyze advertisements
for PDF/document, audio, or video input are not converted to another modality and
are not presented as supported by this provider.

### Advisory Capability Flags

Actualyze's `streaming` and `tool_use` flags are treated as advisory. A `false`
value never removes a model from the discovered catalog, and pi has no per-model
tool-support field. The provider keeps every valid model visible and uses the same
native pi request shape for all of them.

## OpenAI Compatibility

The provider uses pi's native OpenAI Chat Completions implementation and pins a
conservative compatibility profile:

| Behavior            | Setting                       |
| ------------------- | ----------------------------- |
| Output token field  | `max_completion_tokens`       |
| Streamed usage      | Enabled                       |
| `reasoning_effort`  | Enabled                       |
| Finish reasons      | Enabled                       |
| `store`             | Disabled                      |
| Developer role      | Disabled; system role is used |
| Strict tool schemas | Disabled                      |

Contract tests cover exact outbound roles and fields, text and reasoning streams,
reasoning replay via `reasoning_content`, images, Unicode, incremental function
arguments, tool-result continuation, usage, cancellation, routed aliases, error
redaction, and pi's standard context-overflow classification. Context-overflow
messages matching pi's standard patterns retain pi's normal compaction behavior.

### Request Attribution

Every inference request carries an `X-Actualyze-Request-Metadata` header:

```json
{ "agent": "pi", "run_id": "<pi session id>" }
```

Actualyze's Observability Activity tab shows the `agent` value with the `run_id`
beneath it and can filter on both, so one pi session's requests can be found
together. Actualyze records the header on the
request and does not forward it to the model provider.

The session id is left out when pi supplies none or when it does not fit
Actualyze's limits for these values (up to 256 characters drawn from letters,
digits, spaces, and `- : _ @ $ # = / + , .`), so the header never makes a request
fail. If your pi configuration already sets this header for the model or the
request, under any letter case, the provider sends your value unchanged.

## Security

Authenticated traffic is deliberately constrained:

- a key from the environment goes only to an endpoint the environment names, and
  production is a default only for `/login`, whose prompt names the host;
- targets are one validated ASCII DNS label;
- a base URL is an absolute URL without credentials, query, or fragment;
- all requests must use HTTPS, except plain HTTP to a `localhost`, `127.0.0.1`,
  or `[::1]` base URL;
- the origin must exactly match the configured endpoint;
- paths must remain beneath the base URL's path (`/openai/v1` for a target);
- redirects are rejected with `redirect: "error"`;
- cached models from another endpoint are discarded, so the catalog never mixes
  endpoints;
- inference refuses a request before sending credentials when the current catalog
  attributes the model id to another endpoint's base URL, when the model object's
  base URL does not match the active endpoint (direct provider use), or when the id
  is absent from the current non-empty discovered catalog (covering stale sessions
  after upstream catalog changes and models.json-defined entries, which this
  provider does not support);
- the guarded fetch confines credentials to the resolved origin regardless of
  model metadata;
- retries never switch origins;
- catalog and error bodies are size-bounded;
- provider error bodies and headers are sanitized before pi receives them; and
- API keys and authorization headers are redacted from transport errors.

These guarantees cover requests this provider sends. One `models.json`
configuration makes pi bypass it; see [Missing Limits](#missing-limits).

Do not commit credentials, `.env` files, live API response captures, or generated pi
credential stores. Live tests are excluded from the default test suite and require
explicit opt-in flags.

## Timeouts and Resilience

The provider is designed to fail without corrupting a valid catalog:

- **Aggregate request budget:** 10 seconds for list discovery, including retries,
  body reads, and backoff.
- **Retry scope:** HTTP 429 and transient 5xx responses only.
- **Retry delay:** `Retry-After` when valid and affordable within the deadline;
  otherwise bounded exponential backoff.
- **Cancellation:** Parent abort signals stop fetch, body consumption, and sleep.
- **Response limits:** Catalog and provider-error bodies are read with explicit byte
  limits.
- **Atomic refresh:** A malformed generation never partially replaces the current
  model list.
- **Offline startup:** A matching persisted catalog can remain available without a
  successful network refresh.
- **Endpoint isolation:** A cache from another endpoint is removed rather than exposed
  under the current credential.

## pi Commands and CLI Behavior

| Command              | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `/login actualyze`   | Enter an API key, validate it, and discover models            |
| `/model`             | Browse and select discovered Actualyze models                 |
| `/logout actualyze`  | Remove the stored Actualyze credential                        |
| `--actualyze-target` | CLI flag selecting a target (`--actualyze-target=-` for none) |
| `pi list`            | Show installed pi packages                                    |
| `pi remove …`        | Uninstall the package                                         |

### Print Mode and Model Listing

`pi -p` and `pi --list-models` use the saved model list and never fetch it from
Actualyze. pi fetches the list on `/login actualyze`, after interactive pi starts,
and when `/model` opens. The one exception is a run that names an Actualyze model
with `--model`, which fetches the list while pi loads the extension (see
[Refresh and Cache Behavior](#refresh-and-cache-behavior)). Without `--model`, a
new environment that sets the key and endpoint through environment variables and
has no saved list therefore shows no Actualyze models in these modes. Start
interactive pi once, or run `/login actualyze`, to save the list.

When the key and endpoint come only from environment variables, `pi -p` without
`--model` sometimes starts with no model selected and reports "No API key found
for the selected model."
This is a startup race in pi, and it happens more often when `models.json`
exists. Pass `--model actualyze/<model id>`, or log in with `/login actualyze` so
that pi stores the credential.

## Troubleshooting

### pi fails while loading the extension

Start once without extensions:

```bash
pi --no-extensions
```

Then verify:

```bash
pi list
pi --version
```

The package requires pi 1.0.0 or newer. Upgrade pi if `pi --version` reports
an older release.

### `actualyze` does not appear in `/login`

Confirm the package is installed:

```bash
pi list
```

For a local checkout, ensure the listed path still exists. Reinstall if necessary:

```bash
pi remove /absolute/path/to/pi-actualyze
pi install /absolute/path/to/pi-actualyze
```

### Login rejects the target or base URL

Login never asks for an endpoint, so this only happens when `--actualyze-target`,
`ACTUALYZE_TARGET`, or `ACTUALYZE_OPENAI_BASE_URL` holds an invalid value, when a
target and the base URL name different endpoints, or when the target is `-` and
no base URL is set. Pass only the DNS label:

```bash
pi --actualyze-target staging
```

Do not pass `staging.actualyze.ai`, `https://staging.actualyze.ai`, a port, path,
or surrounding whitespace. For an environment outside `*.actualyze.ai`, set
`ACTUALYZE_OPENAI_BASE_URL` instead. Unset all three to log in to production.

### pi exits with `Unknown provider "actualyze"`

pi looks up `--provider actualyze --model <id>` before it refreshes catalogs from
the network, so the provider needs a cached catalog or a successful fetch while
the extension loads. Check that:

- the environment names an endpoint (`ACTUALYZE_TARGET=app` for production, or
  `ACTUALYZE_OPENAI_BASE_URL`) as well as `ACTUALYZE_API_KEY`, or you have run
  `/login actualyze`; a key alone names no endpoint;
- a first run is not started with `--offline`; and
- the endpoint accepts the key: `/login actualyze` reports the error.

A saved login stores its catalog when you log in. If that cache is gone, start
pi once without `--model` and open `/model`, which refreshes it.

### Login returns an authentication or catalog error

Check that:

- the API key belongs to the selected endpoint (production unless you chose
  another one);
- the endpoint's `/models` (for a target,
  `https://<target>.actualyze.ai/openai/v1/models`) is reachable;
- a proxy is not returning HTML or a redirect; and
- the endpoint returns a complete OpenAI-style JSON model list.

The provider intentionally rejects redirects and non-JSON responses.

### Models do not appear in `--list-models` or `pi -p`

These modes show only the saved model list. Start interactive pi once, or run
`/login actualyze`, to fetch and save it. See
[Print Mode and Model Listing](#print-mode-and-model-listing).

### Costs display as zero

Zero means Actualyze lists no cost for the model, so its price is unknown, not
free. See [Pricing](#pricing). After an upgrade from pi-actualyze 2.0.0 or
earlier, a saved model list shows zero costs until pi next refreshes it from
Actualyze.

## Upgrading to 3.0

A saved login from `/login actualyze` keeps working as before. What changes:

- **A key from the environment needs an endpoint.** With `ACTUALYZE_API_KEY` set
  and no `--actualyze-target`, `ACTUALYZE_TARGET`, or
  `ACTUALYZE_OPENAI_BASE_URL`, 2.x sent the key to production. 3.0 sends it
  nowhere, and the provider is unavailable. The same holds for a key passed
  with pi's `--api-key`. To keep using production, add `ACTUALYZE_TARGET=app`
  or run `/login actualyze` once.
- **`ACTUALYZE_OPENAI_BASE_URL`** names the endpoint for a run, so a launcher can
  point pi at an Actualyze environment outside `*.actualyze.ai` (see
  [Another Actualyze Environment by URL](#another-actualyze-environment-by-url)).
  When a target is set as well, both must name the same endpoint.
- **`ACTUALYZE_TARGET=-`** (or `--actualyze-target=-`, with the `=`) selects no
  `*.actualyze.ai` target.
- **A first run with `--provider actualyze --model <id>`** fetches the catalog
  while pi loads the extension, so it works with nothing cached instead of
  exiting with `Unknown provider "actualyze"`.
- **Downgrading.** pi-actualyze 2.x does not read a saved login's
  `ACTUALYZE_OPENAI_BASE_URL` and would send that login's key to production. Run
  `/logout actualyze` before you install 2.x again.
- **SDK hosts.** The controller from `createActualyzeProvider` has a new
  `primeCatalog()` method. A provider env passed to `stream()` may name
  `ACTUALYZE_OPENAI_BASE_URL` instead of `ACTUALYZE_TARGET`; an env whose two
  values name different endpoints is refused before the request is sent.

## Development

Install dependencies and run the complete offline validation suite:

```bash
npm install
npm run check
npm audit --audit-level=low
```

Useful commands:

| Command                 | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `npm run typecheck`     | Strict TypeScript validation                   |
| `npm run lint`          | Biome lint checks                              |
| `npm run format:check`  | Verify formatting                              |
| `npm test`              | Offline unit, lifecycle, and contract tests    |
| `npm run build`         | Build JavaScript and declarations into `dist/` |
| `npm run pack:check`    | Inspect the npm package allowlist              |
| `npm run test:live`     | Explicit credential-gated live tests           |
| `npm run test:contract` | Catalog contract test against a live endpoint  |

The offline suite covers endpoint validation, transport boundaries, redirects,
redaction, hostile catalogs, exact fixture parity, login and cache lifecycle,
native request shape, reasoning replay, images, Unicode, tools, cancellation,
context overflow, and isolated pi package loading.

### Live Tests

Live tests never run through `npm test` or `npm run check`.

Catalog-only parity check:

```bash
ACTUALYZE_TARGET=app \
ACTUALYZE_API_KEY='...' \
npm run test:live
```

Paid streamed tool-loop check:

```bash
ACTUALYZE_TARGET=app \
ACTUALYZE_API_KEY='...' \
ACTUALYZE_LIVE_INFERENCE=1 \
ACTUALYZE_LIVE_MODEL='<model-id>' \
npm run test:live
```

Optional advisory-capability model:

```bash
ACTUALYZE_TARGET=app \
ACTUALYZE_API_KEY='...' \
ACTUALYZE_LIVE_INFERENCE=1 \
ACTUALYZE_LIVE_ADVISORY_MODEL='<model-id>' \
npm run test:live
```

Choose the main live model from catalog entries advertising streaming and tool
use; the advisory model is expected to advertise both as false. The default live
command fetches only the catalog and verifies raw-to-parsed ID parity; the paid
streamed tool loop runs only with the explicit inference flag and model.

To run the same suite against an environment outside `*.actualyze.ai`, such as a
local Actualyze stack or a mock on this machine, name its base URL instead of a
target:

```bash
ACTUALYZE_OPENAI_BASE_URL='http://127.0.0.1:8080/openai/v1' \
ACTUALYZE_API_KEY='...' \
npm run test:live
```

Never enable live tests for untrusted pull requests. Supply credentials only through
protected local or CI secret environments.

### Contract Test

`npm run test:contract` fetches the model list from the endpoint in
`ACTUALYZE_BASE_URL` and checks that the provider parses every entry, in order,
and carries the advertised limits, image input, and reasoning flags into each
model. It also fails if no entry advertises a context or output limit, which
would mean the API renamed those fields. The endpoint must be `https`, or plain
`http` on this machine. Without both variables the test is skipped:

```bash
ACTUALYZE_BASE_URL='https://<target>.actualyze.ai/openai/v1' \
ACTUALYZE_API_KEY='...' \
npm run test:contract
```

The `contract-tests.yml` workflow runs it daily with the endpoint and key held
in the repository's `contract-tests` environment.

## Package Contents

The npm file allowlist contains only:

- `src/`
- `README.md`
- `LICENSE` and npm-generated package metadata

Tests, `.env.example`, credentials, build output, and coverage are excluded.

## Support

pi-actualyze is maintained by [@jsquyres](https://github.com/jsquyres) and
[@dpippenger](https://github.com/dpippenger) at Actualyze AI.

| Topic                     | Support                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bugs and questions        | [GitHub issues](https://github.com/actualyze-ai/pi-actualyze/issues)                                                               |
| Security reports          | Private vulnerability reporting, as described in [SECURITY.md](./SECURITY.md)                                                      |
| Security fix targets      | Critical 3 days, High 30 days, Medium 60 days, Low 90 days                                                                         |
| Supported package version | The latest minor release                                                                                                           |
| Supported hosts           | The versions `package.json` declares: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `>=1.0.0`, Node.js `>=22.19.0` |

CI tests every change against the pi version pinned in `package-lock.json`. A
daily workflow also tests pi's `latest` and `next` releases and opens an issue
labeled `compat` when one fails.

## Verifying Releases

Releases are built and published from this repository by GitHub Actions with
npm trusted publishing, so each version carries a registry signature and a
signed provenance attestation that names the workflow and commit that built
it.

To verify an installed version, install it into an empty project and run
`npm audit signatures`:

```bash
mkdir verify-pi-actualyze && cd verify-pi-actualyze
npm init -y >/dev/null
npm install --ignore-scripts pi-actualyze@<version>
npm audit signatures
```

The output must report verified registry signatures and verified attestations
for `pi-actualyze`. To look at one version's provenance record directly:

```bash
npm view pi-actualyze@<version> dist.attestations
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the architecture overview, development
workflow, invariants that must not regress, and known caveats.

## License

[MIT](./LICENSE) © Actualyze AI, Inc.
