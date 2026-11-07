import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CatalogueService } from "./catalogue.service";
import { ListPlantsQuery } from "./dto/list-plants.query";

@ApiTags("catalogue")
@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get("plants")
  @ApiOperation({
    summary: "Browse the published catalogue",
    description:
      "Cursor paginated. Pass ?city= to get prices: price is resolved per " +
      "market, because what it costs a nursery to keep a plant alive is a " +
      "local fact. Without a city every price comes back null rather than " +
      "defaulting to something plausible a client might render as a quote.",
  })
  listPlants(@Query() query: ListPlantsQuery) {
    return this.catalogue.listPlants(query);
  }

  @Get("plants/:slug")
  @ApiOperation({
    summary: "One plant, its care profile and its buyable variants",
    description:
      "Each variant carries one admin-set price for the requested city and " +
      "the stock available there. Pass ?city= or the prices come back null. " +
      "Which nursery supplies an item is an allocation decision taken at " +
      "checkout, so it is not exposed here: the buyer chooses a size, not a seller.",
  })
  @ApiParam({ name: "slug", example: "monstera-deliciosa" })
  getPlant(@Param("slug") slug: string, @Query("city") city?: string) {
    return this.catalogue.getPlantBySlug(slug, city);
  }

  @Get("categories")
  @ApiOperation({ summary: "Catalogue categories with plant counts" })
  listCategories() {
    return this.catalogue.listCategories();
  }

  @Get("collections")
  @ApiOperation({ summary: "Editorial collections" })
  listCollections() {
    return this.catalogue.listCollections();
  }

  @Get("collections/:slug")
  @ApiOperation({ summary: "One collection and its plants" })
  getCollection(@Param("slug") slug: string) {
    return this.catalogue.getCollectionBySlug(slug);
  }
}
