export const ACTUALYZE_PROVIDER_ID = "actualyze";
export const ACTUALYZE_PROVIDER_NAME = "Actualyze";
export const ACTUALYZE_TARGET_ENV = "ACTUALYZE_TARGET";
export const ACTUALYZE_API_KEY_ENV = "ACTUALYZE_API_KEY";
/**
 * Full OpenAI base URL of the Actualyze environment a launcher points one run
 * at, such as `https://actualyze.example.com/openai/v1`.
 */
export const ACTUALYZE_OPENAI_BASE_URL_ENV = "ACTUALYZE_OPENAI_BASE_URL";
/** pi CLI flag (`--actualyze-target <label>`) that selects a target. */
export const ACTUALYZE_TARGET_FLAG = "actualyze-target";
/** Target value (`ACTUALYZE_TARGET=-`) that selects no `*.actualyze.ai` target. */
export const ACTUALYZE_NO_TARGET = "-";
/** Production target (https://app.actualyze.ai), which login uses when nothing selects an endpoint. */
export const ACTUALYZE_DEFAULT_TARGET = "app";
export const ACTUALYZE_API_PATH = "/openai/v1";
/** Request header through which Actualyze records which agent and run made a call. */
export const ACTUALYZE_REQUEST_METADATA_HEADER = "X-Actualyze-Request-Metadata";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_REQUEST_BUDGET_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_ID_LENGTH = 512;
