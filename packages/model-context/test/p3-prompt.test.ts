import { describe, expect, it } from "vitest";
import {
  BASE_AGENT_PROTOCOL,
  COMPACTION_PROGRAM,
  hashProgram,
  P3_PROGRAMS,
  RESPONSIBILITY_BOUND_PROTOCOL,
  WORK_EXECUTION_PROGRAM,
} from "../src/index.js";

describe("P3 Prompt Program contract artifacts", () => {
  it("exposes the four P3 programs with revision/hash/slots/evalSetRef", () => {
    expect(P3_PROGRAMS.map((program) => program.programId).sort()).toEqual([
      "base-agent-protocol",
      "compaction-program",
      "responsibility-bound-protocol",
      "work-execution-program",
    ]);
    for (const program of P3_PROGRAMS) {
      expect(program.revision).toBeGreaterThan(0);
      expect(program.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(program.slots.length).toBeGreaterThan(0);
      expect(program.evalSetRef).toContain("eval/");
    }
  });

  it("keeps A0-A3 slots non-replaceable and hard", () => {
    for (const program of P3_PROGRAMS) {
      for (const slot of program.slots) {
        if (slot.authorityRole <= "A3") {
          expect(slot.replaceable).toBe(false);
          expect(slot.strength).toBe("Hard");
        }
      }
    }
  });

  it("computes a stable hash over the slot contract", () => {
    const { hash, ...rest } = BASE_AGENT_PROTOCOL;
    expect(hashProgram(rest)).toBe(hash);
    expect(hashProgram({ ...rest, revision: 2 })).not.toBe(hash);
  });

  it("binds the compaction program to a compaction output contract", () => {
    expect(COMPACTION_PROGRAM.outputContractRefs).toContain(
      "compaction-result-v1",
    );
    expect(WORK_EXECUTION_PROGRAM.outputContractRefs).toContain(
      "completion-claim-v1",
    );
    expect(RESPONSIBILITY_BOUND_PROTOCOL.family).toBe(
      "ResponsibilityBoundProtocol",
    );
  });
});
