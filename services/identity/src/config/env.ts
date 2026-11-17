import { Type } from "class-transformer";
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { NodeEnv, ServiceEnv, loadEnv } from "@nursery-co/platform";

export class IdentityEnv extends ServiceEnv {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  override PORT = 4104;

  @IsString()
  @IsNotEmpty()
  JWT_PRIVATE_KEY_PATH!: string;

  @IsString()
  @IsNotEmpty()
  JWT_PUBLIC_KEY_PATH!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  ACCESS_TOKEN_TTL_SECONDS = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  REFRESH_TOKEN_TTL_DAYS = 30;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  REFRESH_REUSE_GRACE_SECONDS = 10;

  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(8)
  OTP_LENGTH = 6;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(900)
  OTP_TTL_SECONDS = 300;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  OTP_MAX_ATTEMPTS = 5;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  OTP_RESEND_SECONDS = 30;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  OTP_MAX_PER_PHONE_PER_HOUR = 5;

  /** Keys the stored hash of each code. */
  @IsString()
  @MinLength(32, { message: "OTP_PEPPER must be at least 32 characters." })
  @MaxLength(200)
  OTP_PEPPER!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  SIGNUP_TOKEN_TTL_SECONDS = 600;

  @IsIn(["console", "msg91"])
  SMS_PROVIDER: "console" | "msg91" = "console";

  @IsOptional()
  @IsString()
  MSG91_AUTH_KEY?: string;

  @IsOptional()
  @IsString()
  MSG91_TEMPLATE_ID?: string;

  /** The template variable the code is passed in. Must match the approved template. */
  @IsOptional()
  @IsString()
  MSG91_OTP_VARIABLE?: string;
}

const PLACEHOLDER = /change-me|dev-only|dev-internal/i;

/**
 * Settings that are fine in development and dangerous in production. A
 * service that would run "open" refuses to start instead.
 */
export function assertProductionSafe(env: IdentityEnv): void {
  // Fail closed: anything that is not explicitly development or test (a
  // "staging" box, or NODE_ENV forgotten) is treated as production.
  if (env.NODE_ENV === NodeEnv.Development || env.NODE_ENV === NodeEnv.Test) return;

  const problems: string[] = [];
  if (env.SMS_PROVIDER === "console") {
    problems.push("SMS_PROVIDER=console prints one-time codes to the log; use a real provider");
  }
  if (env.SMS_PROVIDER === "msg91" && (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID)) {
    problems.push("SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_TEMPLATE_ID");
  }
  if (PLACEHOLDER.test(env.OTP_PEPPER)) problems.push("OTP_PEPPER is still the development placeholder");
  if (PLACEHOLDER.test(env.INTERNAL_API_TOKEN)) problems.push("INTERNAL_API_TOKEN is still the development placeholder");

  if (problems.length) throw new Error(`Unsafe production configuration:\n  - ${problems.join("\n  - ")}`);
}

export function validateIdentityEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const env = loadEnv(IdentityEnv, raw);
  assertProductionSafe(env);
  return env as unknown as Record<string, unknown>;
}
