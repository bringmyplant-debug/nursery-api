import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";
import { ServiceEnv } from "@nursery-co/platform";

export class InventoryEnv extends ServiceEnv {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  override PORT = 4102;
}
