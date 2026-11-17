import "reflect-metadata";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsString, IsUrl, Max, Min } from "class-validator";

/**
 * Gateway environment. No database and no bus: the gateway holds no state
 * and answers nothing itself except health and the merged API description.
 */
export class GatewayEnv {
  @IsString()
  NODE_ENV = "development";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 4000;

  /** Comma-separated browser origins. Native apps send no Origin header. */
  @IsString()
  CORS_ORIGINS = "http://localhost:3000";

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  PARTNER_URL = "http://localhost:4101";

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  INVENTORY_URL = "http://localhost:4102";

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  CATALOGUE_URL = "http://localhost:4103";

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  IDENTITY_URL = "http://localhost:4104";

  /**
   * Which peers may tell us the real client address via X-Forwarded-For:
   * a comma-separated list of IPs, CIDRs or the names `loopback`,
   * `linklocal`, `uniquelocal`. Anyone else's forwarded header is ignored.
   *
   * This matters because rate limits are per client IP. If the header were
   * trusted from anyone, an attacker could send a different fake address on
   * every request and never be throttled. Set it to your load balancer or
   * web-server addresses in production; `false` trusts no one.
   */
  @IsString()
  TRUST_PROXY = "loopback";

  /** Per client IP, for ordinary routes. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_PER_MINUTE = 300;

  /**
   * Per client IP, for /v1/auth. Far lower than the general limit: these
   * routes send SMS messages and check secrets, so they are the ones worth
   * abusing. (The identity service adds per-phone limits underneath.)
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT_PER_MINUTE = 20;
}
