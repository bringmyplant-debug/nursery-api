import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthError } from "../auth/auth-error";
import type { IdentitySettings } from "../config/settings";
import type { PrismaClient } from "../generated/prisma";
import { maskPhone } from "../users/phone";
import {
  challengeState,
  codeMatches,
  generateCode,
  hashCode,
  hourlyWaitSeconds,
  resendWaitSeconds,
} from "./otp.logic";
import type { SmsProvider } from "./sms.provider";

export interface OtpIssued {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

/**
 * One-time codes: issue, send, and check.
 *
 * The properties that matter, and where each is enforced:
 *  - the code is never stored, only a keyed hash                (hashCode)
 *  - a code works once                                          (conditional UPDATE below)
 *  - a code can be guessed at only `otpMaxAttempts` times       (conditional UPDATE below)
 *  - asking for a new code kills the previous one               (issue)
 *  - a number cannot be spammed with messages                   (cooldown + hourly cap)
 *  - the response never reveals whether the number has an account
 */
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sms: SmsProvider,
    private readonly settings: IdentitySettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(phone: string): Promise<OtpIssued> {
    const now = this.now();
    const { otpResendSeconds, otpMaxPerPhonePerHour, otpTtlSeconds, otpLength, otpPepper } = this.settings;

    const id = randomUUID();
    const code = generateCode(otpLength);

    // Check, supersede and create as one unit under a per-phone lock.
    // Without the lock, N parallel requests all read "nothing recent", all
    // pass the cooldown and the hourly cap, and each sends an SMS, which also
    // multiplies the guess budget. The lock makes the second request wait and
    // then see the first one's challenge.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `otp:${phone}`);

      const recent = await tx.otpChallenge.findMany({
        where: { phone, createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });

      const cooldown = resendWaitSeconds(recent.at(-1)?.createdAt ?? null, now, otpResendSeconds);
      if (cooldown > 0) throw AuthError.tooManyRequests(cooldown);

      const hourly = hourlyWaitSeconds(
        recent.map((r) => r.createdAt),
        now,
        otpMaxPerPhonePerHour,
      );
      if (hourly > 0) throw AuthError.tooManyRequests(hourly);

      // Only the newest code is ever valid. Without this, every code ever
      // requested would stay guessable until it expired.
      await tx.otpChallenge.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: now } });
      await tx.otpChallenge.create({
        data: {
          id,
          phone,
          codeHash: hashCode(otpPepper, id, code),
          // From the same clock the limits are measured against, not the
          // database default: any skew between the two would skew the limits.
          createdAt: now,
          expiresAt: new Date(now.getTime() + otpTtlSeconds * 1000),
        },
      });
    });

    try {
      await this.sms.sendOtp(phone, code);
    } catch (error) {
      // A code nobody received must not sit there waiting to be guessed,
      // and the cooldown must not punish the user for our failure.
      await this.prisma.otpChallenge.delete({ where: { id } }).catch(() => undefined);
      this.logger.error(`could not send a code to ${maskPhone(phone)}: ${error instanceof Error ? error.message : error}`);
      throw AuthError.smsUnavailable();
    }

    return { expiresInSeconds: otpTtlSeconds, resendAfterSeconds: otpResendSeconds };
  }

  /** Resolves if `code` is right for `phone`, consuming it. Throws {@link AuthError} otherwise. */
  async verify(phone: string, code: string): Promise<void> {
    const now = this.now();
    const { otpMaxAttempts, otpPepper, otpLength } = this.settings;

    if (!new RegExp(`^\\d{${otpLength}}$`).test(code)) throw AuthError.invalidCode();

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge) throw AuthError.invalidCode();

    switch (challengeState(challenge, now, otpMaxAttempts)) {
      case "usable":
        break;
      case "locked":
        throw AuthError.tooManyAttempts();
      default:
        throw AuthError.invalidCode();
    }

    // Count the attempt *before* comparing, and only if the challenge is
    // still open. Doing it in one conditional UPDATE means two parallel
    // guesses cannot both slip under the limit, and a wrong guess is
    // counted even if the process dies a moment later.
    const counted = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: otpMaxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) throw AuthError.tooManyAttempts();

    if (!codeMatches(challenge.codeHash, otpPepper, challenge.id, code)) {
      this.logger.warn(`wrong code for ${maskPhone(phone)}`);
      throw AuthError.invalidCode();
    }

    // Single use: only one of two concurrent correct submissions wins.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) throw AuthError.invalidCode();
  }

  /** Housekeeping: nothing here is needed after a day. */
  async purge(): Promise<number> {
    const result = await this.prisma.otpChallenge.deleteMany({
      where: { createdAt: { lt: new Date(this.now().getTime() - 86_400_000) } },
    });
    return result.count;
  }
}
