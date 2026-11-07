import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsISO8601, IsOptional } from "class-validator";
import { NurseryStatus, SubscriptionStatus } from "../generated/prisma";

export class UpdateNurseryStatusDto {
  @ApiProperty({ enum: NurseryStatus })
  @IsEnum(NurseryStatus)
  status!: NurseryStatus;
}

export class UpdateSubscriptionDto {
  @ApiProperty({ enum: SubscriptionStatus, required: false })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @ApiProperty({ required: false, description: "ISO-8601 end of the current paid period." })
  @IsOptional()
  @IsISO8601()
  currentPeriodEnd?: string;
}
