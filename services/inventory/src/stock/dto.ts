import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";

export enum Condition {
  PREMIUM = "PREMIUM",
  STANDARD = "STANDARD",
  NURSERY_FRESH = "NURSERY_FRESH",
}

export class SetStockDto {
  @ApiProperty({ minimum: 0, description: "Units on hand, including any reserved." })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stock!: number;

  @ApiProperty({ required: false, minimum: 0, description: "Units committed to unpaid orders. Must not exceed stock." })
  @IsOptional()
  @IsInt()
  @Min(0)
  reserved?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, enum: Condition })
  @IsOptional()
  @IsEnum(Condition)
  condition?: Condition;
}
