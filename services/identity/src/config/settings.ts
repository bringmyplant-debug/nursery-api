import { ConfigService } from "@nestjs/config";
import { loadPemKey } from "@nursery-co/platform";

/** DI token for {@link IdentitySettings}. */
export const SETTINGS = Symbol("IDENTITY_SETTINGS");

/**
 * Everything the auth logic needs, resolved once at boot into plain values.
 * Keeping it a plain object (not ConfigService calls scattered through the
 * code) is what lets the services be constructed directly in tests.
 */
export interface IdentitySettings {
  privateKey: string;
  publicKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  refreshReuseGraceSeconds: number;
  otpLength: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendSeconds: number;
  otpMaxPerPhonePerHour: number;
  otpPepper: string;
  signupTokenTtlSeconds: number;
}

export function settingsFrom(config: ConfigService): IdentitySettings {
  return {
    privateKey: loadPemKey(config.get<string>("JWT_PRIVATE_KEY_PATH"), "JWT_PRIVATE_KEY_PATH"),
    publicKey: loadPemKey(config.get<string>("JWT_PUBLIC_KEY_PATH"), "JWT_PUBLIC_KEY_PATH"),
    accessTokenTtlSeconds: config.getOrThrow<number>("ACCESS_TOKEN_TTL_SECONDS"),
    refreshTokenTtlDays: config.getOrThrow<number>("REFRESH_TOKEN_TTL_DAYS"),
    refreshReuseGraceSeconds: config.getOrThrow<number>("REFRESH_REUSE_GRACE_SECONDS"),
    otpLength: config.getOrThrow<number>("OTP_LENGTH"),
    otpTtlSeconds: config.getOrThrow<number>("OTP_TTL_SECONDS"),
    otpMaxAttempts: config.getOrThrow<number>("OTP_MAX_ATTEMPTS"),
    otpResendSeconds: config.getOrThrow<number>("OTP_RESEND_SECONDS"),
    otpMaxPerPhonePerHour: config.getOrThrow<number>("OTP_MAX_PER_PHONE_PER_HOUR"),
    otpPepper: config.getOrThrow<string>("OTP_PEPPER"),
    signupTokenTtlSeconds: config.getOrThrow<number>("SIGNUP_TOKEN_TTL_SECONDS"),
  };
}
