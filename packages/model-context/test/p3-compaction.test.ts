import {
  ContextEpochNumber as CEN,
  type ContextEpochNumber,
  ExecutionId as EID,
  type ExecutionId,
  parse,
  type SessionId,
  SessionId as SID,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import {
  buildCompactionRequest,
  COMPACTION_OUTPUT_CONTRACT,
  validateCompactionResult,
} from "../src/index.js";

const request = buildCompactionRequest({
  executionId: parse(EID)(
    "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ) as ExecutionId,
  sessionId: parse(SID)(
    "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ) as SessionId,
  currentEpoch: parse(CEN)(0) as ContextEpochNumber,
  reason: "BudgetPressure",
});

describe("P3 compaction protocol", () => {
  it("binds the compaction turn to the compaction program + output contract", () => {
    expect(request.programId).toBe("compaction-program");
    expect(request.outputContractRef).toBe(COMPACTION_OUTPUT_CONTRACT);
  });

  it("accepts a well-formed compaction result", () => {
    expect(
      validateCompactionResult(
        { checkpoint: { ref: "cp_1", summaryRef: "sum_1" }, newEpoch: 1 },
        request,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects malformed results as ModelOutputContractViolation", () => {
    for (const bad of [
      null,
      {},
      { checkpoint: { ref: "cp" }, newEpoch: 1 },
      { checkpoint: { ref: "cp", summaryRef: "s" }, newEpoch: 5 },
    ]) {
      const result = validateCompactionResult(bad, request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violation).toBe("ModelOutputContractViolation");
      }
    }
  });
});
