import type { SqlClient } from "@nursery-co/platform";
import { applyAvailability, isNewer } from "./availability.projection";

describe("isNewer", () => {
  it("accepts anything when nothing is held", () => {
    expect(isNewer(null, 1)).toBe(true);
  });

  it("accepts only strictly newer versions", () => {
    expect(isNewer(3, 4)).toBe(true);
    expect(isNewer(3, 3)).toBe(false); // redelivery
    expect(isNewer(3, 2)).toBe(false); // late straggler
  });
});

describe("applyAvailability", () => {
  const data = { variantId: "v", city: "Pune", available: 5, holders: 2, version: 3 };

  const clientReturning = (rows: number) => {
    const executeRawUnsafe = vi.fn().mockResolvedValue(rows);
    return { client: { $executeRawUnsafe: executeRawUnsafe, $queryRawUnsafe: vi.fn() } as unknown as SqlClient, executeRawUnsafe };
  };

  it("binds every value rather than interpolating it", async () => {
    const { client, executeRawUnsafe } = clientReturning(1);
    await applyAvailability(client, data);

    const [sql, ...values] = executeRawUnsafe.mock.calls[0];
    expect(values).toEqual(["v", "Pune", 5, 2, 3]);
    expect(sql).not.toContain("Pune");
  });

  it("guards on version inside the statement, so a stale event cannot overwrite a newer row", async () => {
    const { client, executeRawUnsafe } = clientReturning(0);
    await applyAvailability(client, data);
    expect(executeRawUnsafe.mock.calls[0][0]).toMatch(/WHERE variant_availability\.version < EXCLUDED\.version/);
  });

  it("reports whether the row changed", async () => {
    expect(await applyAvailability(clientReturning(1).client, data)).toBe(true);
    expect(await applyAvailability(clientReturning(0).client, data)).toBe(false);
  });
});
