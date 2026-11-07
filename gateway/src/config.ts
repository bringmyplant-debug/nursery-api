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

  /** Per client IP. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_PER_MINUTE = 300;
}
