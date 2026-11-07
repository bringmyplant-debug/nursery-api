import "reflect-metadata";
import { plainToInstance, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from "class-validator";

export enum NodeEnv {
  Development = "development",
  Test = "test",
  Production = "production",
}

/**
 * What every service needs to start.
 *
 * Validated once at boot: a missing or weak value should stop the process
 * on startup, not surface as a 500 when the first request needing it
 * arrives. Services extend this with their own port and settings.
 */
export class ServiceEnv {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 4000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  /** Where the message bus listens. */
  @IsString()
  @IsNotEmpty()
  NATS_URL = "nats://localhost:4222";

  /**
   * Shared secret for service-to-service calls to `/internal/*`.
   *
   * This is the minimum viable control, not the end state: it proves the
   * caller is *something inside the network*, not which service. When the
   * deployment target is settled, replace it with mTLS or per-service
   * signed tokens so a compromised service cannot impersonate another.
   */
  @IsString()
  @MinLength(16, { message: "INTERNAL_API_TOKEN must be at least 16 characters." })
  INTERNAL_API_TOKEN!: string;
}

/**
 * Validate raw process.env against an env class.
 *
 * Generic so the gateway — which has no database — can validate its own
 * shape with the same machinery the services use.
 */
export function loadEnv<T extends object>(cls: new () => T, raw: Record<string, unknown>): T {
  const parsed = plainToInstance(cls, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join(", ")}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  // The .env.example placeholder passes a length check. It must not pass
  // in production.
  const record = parsed as Record<string, unknown>;
  if (
    record.NODE_ENV === NodeEnv.Production &&
    typeof record.INTERNAL_API_TOKEN === "string" &&
    /change-me|dev-only/i.test(record.INTERNAL_API_TOKEN)
  ) {
    throw new Error("INTERNAL_API_TOKEN is still the development placeholder.");
  }

  return parsed;
}

