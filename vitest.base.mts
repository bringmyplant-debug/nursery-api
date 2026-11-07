import swc from "unplugin-swc";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Shared Vitest settings.
 *
 * Vitest rather than Jest because NestJS 12 and the NATS client ship ES
 * modules only while these services compile to CommonJS; Jest's module
 * loader refuses that mix on Node < 24.9, Vitest's does not care.
 *
 * SWC (not esbuild) so `emitDecoratorMetadata` works — Nest's dependency
 * injection reads the constructor parameter types it emits.
 */
export function serviceTestConfig(): ViteUserConfig {
  return defineConfig({
    plugins: [
      swc.vite({
        jsc: {
          target: "es2023",
          parser: { syntax: "typescript", decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      }),
    ],
    test: {
      include: ["src/**/*.spec.ts"],
      environment: "node",
      // Generous: CI and a busy laptop run every package at once, and a slow
      // plugin load in a beforeAll should not read as a failing suite.
      hookTimeout: 30_000,
      testTimeout: 15_000,
      globals: true,
      coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/**/*.spec.ts", "src/generated/**"] },
    },
  });
}
