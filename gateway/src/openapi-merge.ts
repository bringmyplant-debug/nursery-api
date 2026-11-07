import { isPublicPath } from "./routes";

/** The parts of an OpenAPI 3 document the merge touches. */
export interface OpenApiDoc {
  openapi?: string;
  info?: Record<string, unknown>;
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  tags?: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

export interface MergeResult {
  document: OpenApiDoc;
  /** Things the merge had to resolve; surfaced so a collision is never silent. */
  warnings: string[];
}

/**
 * Combine each service's API description into the one a client sees.
 *
 * Only paths on the public allow-list are kept, so a service's internal
 * routes can never leak into published documentation even if one forgot to
 * hide itself from Swagger.
 *
 * Collisions are reported, never silently resolved: two services defining
 * the same path, or a schema name with two different shapes, means a
 * client generated from this document would be wrong for one of them. The
 * first definition wins and the conflict is returned as a warning.
 */
export function mergeOpenApi(inputs: { service: string; doc: OpenApiDoc }[]): MergeResult {
  const warnings: string[] = [];
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  const tags = new Map<string, { name: string }>();

  for (const { service, doc } of inputs) {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (!isPublicPath(path)) continue;
      if (path in paths) {
        warnings.push(`path ${path} is defined by more than one service; kept the first, ignored ${service}'s`);
        continue;
      }
      paths[path] = item;
    }

    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      if (!(name in schemas)) {
        schemas[name] = schema;
      } else if (JSON.stringify(schemas[name]) !== JSON.stringify(schema)) {
        warnings.push(`schema ${name} differs between services; kept the first, ignored ${service}'s`);
      }
    }

    for (const tag of doc.tags ?? []) if (!tags.has(tag.name)) tags.set(tag.name, tag);
  }

  return {
    document: {
      openapi: "3.0.0",
      info: { title: "Bring My Plants API", version: "1.0" },
      paths,
      components: { schemas },
      tags: [...tags.values()],
    },
    warnings,
  };
}
