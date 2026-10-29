import { ExecutionId, parse, providerTurnInferenceId } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { providerTurnIdBatches } from "../src/provider-turn-project-store.js";

describe("ProviderTurn project recovery query batching", () => {
  it("keeps every SQLite IN query below the fixed parameter batch size", () => {
    const executionId = parse(ExecutionId)(
      "exe_019fffff-ffff-7000-8000-00000000a303",
    );
    const ids = Array.from({ length: 1_201 }, (_, index) =>
      providerTurnInferenceId(executionId, index),
    );
    const batches = providerTurnIdBatches(ids);

    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
    expect(batches.flat()).toEqual(ids);
  });
});
