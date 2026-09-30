import { describe, expect, it } from "vitest";
import { providerTurnIdBatches } from "../src/provider-turn-project-store.js";

describe("ProviderTurn project recovery query batching", () => {
  it("keeps every SQLite IN query below the fixed parameter batch size", () => {
    const ids = Array.from({ length: 1_201 }, (_, index) => `ptn_${index}`);
    const batches = providerTurnIdBatches(ids);

    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
    expect(batches.flat()).toEqual(ids);
  });
});
