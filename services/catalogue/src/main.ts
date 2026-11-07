import { bootstrapService } from "@nursery-co/platform";
import { AppModule } from "./app.module";

bootstrapService({
  module: AppModule,
  service: "catalogue",
  title: "Catalogue service",
  description: "Plants, variants, per-city prices and collections.",
}).catch((error) => {
  console.error("catalogue failed to start", error);
  process.exit(1);
});
