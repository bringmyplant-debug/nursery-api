import "dotenv/config";
import { loadEnv } from "@nursery-co/platform";
import { buildApp } from "./app";
import { GatewayEnv } from "./config";

async function main(): Promise<void> {
  const env = loadEnv(GatewayEnv, process.env);
  const app = await buildApp(env);

  const close = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("gateway failed to start", error);
  process.exit(1);
});
