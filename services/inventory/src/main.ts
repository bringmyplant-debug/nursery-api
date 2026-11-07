import { bootstrapService } from "@nursery-co/platform";
import { AppModule } from "./app.module";

bootstrapService({
  module: AppModule,
  service: "inventory",
  title: "Inventory service",
  description: "Stock per nursery and buyable availability per city.",
}).catch((error) => {
  console.error("inventory failed to start", error);
  process.exit(1);
});
