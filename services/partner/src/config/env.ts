import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";
import { ServiceEnv } from "@nursery-co/platform";

export class PartnerEnv extends ServiceEnv {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  override PORT = 4101;

  /**
   * How often to look for nurseries whose subscription has run past its
   * end date. A lapsed nursery keeps selling for at most this long.
   */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @IsOptional()
  SELLABILITY_SWEEP_SECONDS = 60;

  /** Verifies access tokens. Only the identity service holds the matching private key. */
  @IsString()
  @IsNotEmpty()
  JWT_PUBLIC_KEY_PATH!: string;
}
