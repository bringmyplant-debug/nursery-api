import { bootstrapService } from "@nursery-co/platform";
import { AppModule } from "./app.module";

bootstrapService({
  module: AppModule,
  service: "identity",
  title: "Identity service",
  description: "Sign-up, sign-in and sessions.",
}).catch((error) => {
  console.error("identity failed to start", error);
  process.exit(1);
});
