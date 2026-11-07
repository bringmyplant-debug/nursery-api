import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { CursorQuery } from "@nursery-co/platform";
import { Difficulty, LightNeed, Placement, Season, WaterNeed } from "../../generated/prisma";

export enum PlantSort {
  Popular = "popular",
  PriceAsc = "price_asc",
  PriceDesc = "price_desc",
  Name = "name",
  Newest = "newest",
}

/** `?light=LOW&light=FULL_SUN` and `?light=LOW,FULL_SUN` both work. */
const toArray = ({ value }: { value: unknown }): unknown[] | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
};

/** Accepts `true`, `1`, `yes`: query strings have no real booleans. */
const toBool = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
};

export class ListPlantsQuery extends CursorQuery {
  @ApiPropertyOptional({ description: "Free text over name, botanical name and tags." })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: "Category slug." })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description:
      "The market. Decides both which stock counts and which price each " +
      "variant resolves to: a plant costs a different amount to keep alive " +
      "in Delhi than in Chennai. Omit it and every price field comes back " +
      "null, along with the price filters and sorts that depend on them.",
    example: "Pune",
  })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ enum: LightNeed, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(LightNeed, { each: true })
  light?: LightNeed[];

  @ApiPropertyOptional({ enum: WaterNeed, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(WaterNeed, { each: true })
  water?: WaterNeed[];

  @ApiPropertyOptional({ enum: Difficulty, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(Difficulty, { each: true })
  difficulty?: Difficulty[];

  @ApiPropertyOptional({ enum: Placement })
  @IsOptional()
  @IsEnum(Placement)
  placement?: Placement;

  @ApiPropertyOptional({ description: "Non-toxic to cats and dogs." })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  petSafe?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  airPurifying?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  flowering?: boolean;

  @ApiPropertyOptional({
    description:
      "Upper bound on the plant's cheapest size in the requested city, in " +
      "paise. Ignored without a city, since there is nothing to compare to.",
    example: 50000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPricePaise?: number;

  @ApiPropertyOptional({
    enum: Season,
    description:
      "Peak season. ALL_SEASON plants always match, so a summer filter still " +
      "returns the evergreens.",
  })
  @IsOptional()
  @IsEnum(Season)
  season?: Season;

  @ApiPropertyOptional({ description: "Hide plants no nursery currently holds stock for." })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  inStockOnly?: boolean;

  @ApiPropertyOptional({ enum: PlantSort, default: PlantSort.Popular })
  @IsOptional()
  @IsEnum(PlantSort)
  sort: PlantSort = PlantSort.Popular;
}
