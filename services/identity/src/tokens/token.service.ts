import { Logger } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { signAccessToken, type UserRole } from "@nursery-co/platform";
import { AuthError } from "../auth/auth-error";
import type { IdentitySettings } from "../config/settings";
import type { PrismaClient } from "../generated/prisma";
import { classifyRefresh } from "./refresh.logic";

export interface SessionUser {
  id: string;
  role: UserRole;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

/** Only the hash is ever stored. 256 random bits need no slow hash. */
export const hashRefreshToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const newRefreshToken = (): string => randomBytes(32).toString("base64url");

/**
 * Sessions: short-lived signed access tokens, and long-lived refresh tokens
 * that are single-use and rotate on every refresh.
 */
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: IdentitySettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Start a new session (a new token family) for a user who just proved who they are. */
  async startSession(user: SessionUser, userAgent?: string): Promise<Tokens> {
    return this.mint(user, randomUUID(), userAgent);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Throws `invalid_refresh_token` (401) when the session is over, and
   * `refresh_in_flight` (409) when another request refreshed it a moment
   * ago; the latter is a retry-with-the-new-token signal, never a logout.
   */
  async rotate(presented: string, userAgent?: string): Promise<{ tokens: Tokens; userId: string }> {
    const now = this.now();
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(presented) },
      include: { user: { select: { id: true, role: true, status: true } } },
    });

    switch (classifyRefresh(row, now, this.settings.refreshReuseGraceSeconds)) {
      case "valid":
        break;
      case "in-flight":
        throw AuthError.refreshInFlight();
      case "reuse":
        // The signature of theft: a token that was already used, presented
        // again long after. End the whole session, thief and owner alike;
        // the owner signs in again, the thief cannot.
        await this.revokeFamily(row!.familyId);
        this.logger.warn(`refresh token reuse detected for user ${row!.userId}; session family revoked`);
        throw AuthError.invalidRefreshToken();
      default:
        throw AuthError.invalidRefreshToken();
    }

    const stored = row!;
    if (stored.user.status !== "ACTIVE") {
      await this.revokeFamily(stored.familyId);
      throw AuthError.invalidRefreshToken();
    }

    const next = newRefreshToken();
    const nextId = randomUUID();
    const expiresAt = new Date(now.getTime() + this.settings.refreshTokenTtlDays * 86_400_000);

    // Claim the old token and create its successor atomically. The
    // conditional UPDATE is the lock: if two requests race here, exactly one
    // sees count 1; the other rolls back and reports in-flight.
    const won = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, replacedById: nextId },
      });
      if (claimed.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          id: nextId,
          userId: stored.userId,
          familyId: stored.familyId,
          tokenHash: hashRefreshToken(next),
          userAgent: userAgent?.slice(0, 300),
          expiresAt,
        },
      });
      return true;
    });
    if (!won) throw AuthError.refreshInFlight();

    return {
      userId: stored.userId,
      tokens: this.pair({ id: stored.user.id, role: stored.user.role }, stored.familyId, next),
    };
  }

  /** Sign out. Idempotent, and silent about unknown tokens: there is nothing useful to tell the caller. */
  async revoke(presented: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(presented) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  /** Sign out everywhere. Active access tokens still work until they expire (at most the access TTL). */
  async revokeAllFor(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  private async mint(user: SessionUser, familyId: string, userAgent?: string): Promise<Tokens> {
    const refreshToken = newRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: hashRefreshToken(refreshToken),
        userAgent: userAgent?.slice(0, 300),
        expiresAt: new Date(this.now().getTime() + this.settings.refreshTokenTtlDays * 86_400_000),
      },
    });
    return this.pair(user, familyId, refreshToken);
  }

  private pair(user: SessionUser, familyId: string, refreshToken: string): Tokens {
    return {
      accessToken: signAccessToken(
        this.settings.privateKey,
        { sub: user.id, role: user.role, sid: familyId },
        this.settings.accessTokenTtlSeconds,
      ),
      refreshToken,
      accessTokenExpiresIn: this.settings.accessTokenTtlSeconds,
      refreshTokenExpiresIn: this.settings.refreshTokenTtlDays * 86_400,
    };
  }

  /** Housekeeping: drop long-dead tokens. */
  async purge(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - 7 * 86_400_000);
    const result = await this.prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return result.count;
  }
}
