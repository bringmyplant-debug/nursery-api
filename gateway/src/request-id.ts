import { randomUUID } from "node:crypto";

/**
 * What an inbound request id may look like to be trusted.
 *
 * The id ends up in every service's logs and in error responses. Accepting
 * arbitrary client text there is a log-injection vector (newlines forging
 * entries) and lets one client reuse another's id, so only a conservative
 * shape is honoured and anything else is replaced.
 */
const ACCEPTABLE = /^[A-Za-z0-9._-]{8,64}$/;

export function requestIdFrom(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate && ACCEPTABLE.test(candidate) ? candidate : randomUUID();
}
