import { Logger } from "@nestjs/common";
import { TokenError, signScopedToken, verifyScopedToken } from "@nursery-co/platform";
import type { IdentitySettings } from "../config/settings";
import { Prisma, type PrismaClient, type User } from "../generated/prisma";
import type { OtpService } from "../otp/otp.service";
import type { TokenService, Tokens } from "../tokens/token.service";
import { maskPhone, normalizeIndianMobile } from "../users/phone";
import { AuthError } from "./auth-error";

/** Audience of the token that lets a verified phone register. Never valid as an access token. */
export const SIGNUP_AUDIENCE = "nursery-signup";

export interface PublicUser {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  role: "BUYER" | "ADMIN";
  createdAt: Date;
}

export type VerifyResult =
  | { status: "signed_in"; user: PublicUser; tokens: Tokens }
  | { status: "profile_required"; signupToken: string; signupTokenExpiresIn: number };

export interface SignupInput {
  signupToken: string;
  name: string;
  email?: string | null;
  acceptTerms: true;
}

export const toPublicUser = (u: Pick<User, "id" | "phone" | "email" | "name" | "role" | "createdAt">): PublicUser => ({
  id: u.id,
  phone: u.phone,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
});

/**
 * Sign-up and sign-in are one flow, deliberately.
 *
 *   phone ─▶ code ─▶ known number? ──yes──▶ signed in
 *                          └──no───▶ profile (name, terms) ─▶ signed in
 *
 * Why one flow rather than two forms:
 *  - Nothing reveals whether a number is registered until the caller has
 *    proved they hold it, so the endpoints cannot be used to enumerate
 *    customers.
 *  - No account is ever created for a number nobody has verified.
 *  - There is no password to forget, reuse, leak or phish.
 */
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly settings: IdentitySettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The answer is identical whether or not the number has an account. */
  async requestOtp(phoneInput: string) {
    const phone = this.phoneOrThrow(phoneInput);
    return this.otp.issue(phone);
  }

  async verifyOtp(phoneInput: string, code: string, userAgent?: string): Promise<VerifyResult> {
    const phone = this.phoneOrThrow(phoneInput);
    await this.otp.verify(phone, code);

    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return {
        status: "profile_required",
        signupToken: signScopedToken(this.settings.privateKey, SIGNUP_AUDIENCE, { phone }, this.settings.signupTokenTtlSeconds),
        signupTokenExpiresIn: this.settings.signupTokenTtlSeconds,
      };
    }
    if (user.status !== "ACTIVE") throw AuthError.accountSuspended();

    return this.signIn(user, userAgent);
  }

  async completeSignup(input: SignupInput, userAgent?: string): Promise<{ user: PublicUser; tokens: Tokens }> {
    let phone: string;
    try {
      phone = verifyScopedToken<{ phone: string }>(this.settings.publicKey, SIGNUP_AUDIENCE, input.signupToken).phone;
    } catch (error) {
      if (error instanceof TokenError) throw AuthError.invalidSignupToken();
      throw error;
    }

    const now = this.now();
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          phone,
          name: input.name,
          email: input.email ?? null,
          // Never from the client. Everyone starts as a buyer; promotion is an operator action.
          role: "BUYER",
          phoneVerifiedAt: now,
          termsAcceptedAt: now,
          lastLoginAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = JSON.stringify(error.meta ?? {});
        throw /email/i.test(target) ? AuthError.emailTaken() : AuthError.alreadyRegistered();
      }
      throw error;
    }

    this.logger.log(`new account ${user.id} (${maskPhone(phone)})`);
    return { user: toPublicUser(user), tokens: await this.tokens.startSession(user, userAgent) };
  }

  async refresh(refreshToken: string, userAgent?: string): Promise<{ user: PublicUser; tokens: Tokens }> {
    const { tokens, userId } = await this.tokens.rotate(refreshToken, userAgent);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AuthError.invalidRefreshToken();
    return { user: toPublicUser(user), tokens };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.tokens.revokeAllFor(userId);
  }

  /** The signed-in user, or null if the account is gone or suspended (a still-valid access token does not outlive that). */
  async currentUser(userId: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user && user.status === "ACTIVE" ? toPublicUser(user) : null;
  }

  async updateProfile(userId: string, patch: { name?: string; email?: string | null }): Promise<PublicUser> {
    try {
      // ACTIVE in the filter: a suspended account cannot edit itself with a
      // token minted before it was suspended.
      const user = await this.prisma.user.update({
        where: { id: userId, status: "ACTIVE" },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.email !== undefined ? { email: patch.email } : {}),
        },
      });
      return toPublicUser(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") throw AuthError.emailTaken();
        if (error.code === "P2025") throw AuthError.notFound();
      }
      throw error;
    }
  }

  private async signIn(user: User, userAgent?: string): Promise<VerifyResult> {
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: this.now() } });
    return { status: "signed_in", user: toPublicUser(user), tokens: await this.tokens.startSession(user, userAgent) };
  }

  private phoneOrThrow(input: string): string {
    const phone = normalizeIndianMobile(input);
    if (!phone) throw AuthError.invalidPhone();
    return phone;
  }
}
