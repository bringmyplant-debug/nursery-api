import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
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
}
