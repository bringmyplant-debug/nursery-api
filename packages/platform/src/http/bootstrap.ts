import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger, Type, ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

export interface BootstrapOptions {
  /** The service's root module. */
  module: Type<unknown>;
  /** Short name used in logs and as the event `producer`. */
  service: string;
  /** OpenAPI title and description — the gateway merges these into one spec. */
  title: string;
  description: string;
}

/**
 * The boot sequence every service shares.
 *
 * Everything that has to be identical across services lives here, so a
 * fourth service is a module and a `main.ts` of six lines, and so a fix to
 * (say) the validation policy is made once. What is deliberately *not*
 * here: CORS and rate limiting. Those are edge concerns and belong to the
 * gateway; a service sitting behind it never sees a browser.
 */
export async function bootstrapService(options: BootstrapOptions): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    options.module,
    new FastifyAdapter({
      trustProxy: true,
      // Honour the id the gateway assigned, so one request is one id from
      // the browser through every service it touches. Generate our own
      // only when called directly (a health probe, a developer's curl).
      requestIdHeader: "x-request-id",
      genReqId: () => randomUUID(),
    }),
    { bufferLogs: true },
  );

  const config = app.get(ConfigService);
  const isDev = config.get<string>("NODE_ENV") === "development";

  /**
   * URI versioning from the first commit, as in the monolith. An
   * installed mobile app cannot be force-updated, so v1 has to keep
   * answering long after v2 exists. Services keep the `/v1` prefix the
   * gateway exposes, so proxying is a straight pass-through with no path
   * rewriting to get wrong.
   */
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown fields outright rather than silently dropping them —
      // a caller sending `pricePaise` where we expect `price` should be told.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.register(helmet, { contentSecurityPolicy: false });

  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", (request, reply, done) => {
      reply.header("x-request-id", request.id);
      done();
    });

  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(options.title)
      .setDescription(options.description)
      .setVersion("1.0")
      .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "access-token")
      .build(),
  );
  SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "docs/openapi.json" });

  const port = config.get<number>("PORT") ?? 4000;
  await app.listen(port, "0.0.0.0");

  const logger = new Logger(`${options.service}-service`);
  logger.log(`listening on http://localhost:${port}`);
  if (isDev) logger.log(`OpenAPI docs at http://localhost:${port}/docs`);

  return app;
}
