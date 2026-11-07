import { bootstrapService } from "@nursery-co/platform";
import { AppModule } from "./app.module";

bootstrapService({
  module: AppModule,
  service: "partner",
  title: "Partner service",
  description: "Nurseries, plans and subscriptions.",
}).catch((error) => {
  console.error("partner failed to start", error);
  process.exit(1);
});

