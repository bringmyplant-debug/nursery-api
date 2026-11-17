import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { type AccessClaims, type UserRole, TokenError, loadPemKey, verifyAccessToken } from "./jwt";

export type AuthedRequest = FastifyRequest & { user?: AccessClaims };

const ROLES_KEY = "roles";

/** Restrict a route to these roles. Use together with {@link JwtAuthGuard}. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The verified claims of the caller. Only meaningful behind {@link JwtAuthGuard}. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AccessClaims => {
  return context.switchToHttp().getRequest<AuthedRequest>().user as AccessClaims;
});

/**
 * Authenticates a request from its `Authorization: Bearer` access token.
 *
 * Every service verifies tokens itself against the public key; none trusts
 * a "who is this" header from upstream, because on a network where any
 * service can reach any other, such a header is just text anyone can send.
 *
 * Needs `JWT_PUBLIC_KEY_PATH` (or an inline PEM) in the service's
 * environment. Fails at construction, i.e. at boot, if it is missing, so a
 * misconfigured service never starts "open".
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly publicKey: string;

  constructor(
    config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.publicKey = loadPemKey(config.get<string>("JWT_PUBLIC_KEY_PATH"), "JWT_PUBLIC_KEY_PATH");
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header) : null;
    if (!match) throw new UnauthorizedException();

    let claims: AccessClaims;
    try {
      claims = verifyAccessToken(this.publicKey, match[1]);
    } catch (error) {
      if (error instanceof TokenError) throw new UnauthorizedException();
      throw error;
    }

    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !required.includes(claims.role)) throw new ForbiddenException();

    request.user = claims;
    return true;
  }
}
