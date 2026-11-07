import { createHash, timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest } from "fastify";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/**
 * Guards `/internal/*` routes: service-to-service calls and operator
 * tooling, never end users.
 *
 * Two layers protect these routes. The gateway only proxies an explicit
 * allow-list of public prefixes, so `/internal` is unreachable from the
 * internet in the first place; this guard is the second layer, for the
 * day a misconfigured route or a compromised neighbour reaches a service
 * directly. Neither layer alone should be trusted.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>("INTERNAL_API_TOKEN");
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const supplied = request.headers[INTERNAL_TOKEN_HEADER];

    if (!expected || typeof supplied !== "string" || !tokensMatch(supplied, expected)) {
      // Same response whether the header was missing or wrong: do not
      // confirm which part of the guess was off.
      throw new UnauthorizedException();
    }
    return true;
  }
}

/**
 * Constant-time comparison.
 *
 * Hashing both sides first gives `timingSafeEqual` the equal-length
 * buffers it requires without a length check that would itself leak the
 * secret's length through response timing.
 */
export function tokensMatch(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
