/** Error codes undici and Node raise when an upstream cannot be reached or does not answer in time. */
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
]);

interface ErrorLike {
  statusCode?: number;
  code?: string;
  cause?: unknown;
}

/** Every `code` along the chain of causes, outermost first. */
function* codesOf(error: unknown): Generator<string> {
  for (let e = error as ErrorLike | undefined, depth = 0; e && typeof e === "object" && depth < 5; e = e.cause as ErrorLike, depth++) {
    if (typeof e.code === "string") yield e.code;
  }
}

/**
 * The HTTP status the gateway should answer with for a failure.
 *
 * A connection error is the *upstream's* failure and must read as one
 * (502, or 504 for a timeout), not as a gateway bug (500): the difference
 * decides whether someone investigates the gateway or the service behind it.
 *
 * The proxy library wraps a refused connection as a generic 500 and keeps
 * the real reason on `cause`, so the chain is inspected before the wrapper's
 * own status is believed.
 */
export function statusFor(error: unknown): number {
  for (const code of codesOf(error)) {
    if (TIMEOUT_CODES.has(code)) return 504;
    if (UNREACHABLE_CODES.has(code)) return 502;
  }
  const explicit = (error as ErrorLike | undefined)?.statusCode;
  return typeof explicit === "number" && explicit >= 400 ? explicit : 500;
}
