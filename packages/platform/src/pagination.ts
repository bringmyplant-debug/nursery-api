import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Cursor pagination, not offset.
 *
 * Offset breaks exactly where this product uses it most: an infinite-scroll
 * catalogue where rows are inserted and stock changes between pages. With
 * OFFSET 40 the reader silently skips or repeats items whenever the set
 * shifts underneath them. A cursor anchors to a row instead.
 */
export class CursorQuery {
  @ApiPropertyOptional({
    description: "Opaque cursor from the previous response's `nextCursor`.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 24;
}

export class PageMeta {
  @ApiProperty({ description: "Pass back as `cursor` for the next page.", nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;

  @ApiProperty({ description: "Items in this page." })
  count!: number;
}

export class Page<T> {
  data!: T[];
  meta!: PageMeta;
}

/** Cursors are opaque to clients; base64 keeps them from being hand-edited. */
export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T = Record<string, unknown>>(cursor?: string): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    // A malformed cursor is a client bug, not a server error — start over
    // rather than 500 and strand the client on a page it cannot leave.
    return null;
  }
}

export function toPage<T>(rows: T[], limit: number, makeCursor: (row: T) => string): Page<T> {
  // Fetch limit+1 upstream; the extra row only answers "is there more?".
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    meta: {
      nextCursor: hasMore && data.length ? makeCursor(data[data.length - 1]) : null,
      hasMore,
      count: data.length,
    },
  };
}
