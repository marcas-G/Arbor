import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertProgramGate,
  evalAllPrograms,
  evaluateProgramContent,
  loadProgram,
  loadProgramContent,
  PROGRAM_REGISTRY,
  type ProgramError,
  type ProgramRegistryEntry,
  programFilePath,
  sha256Hex,
  verifyEvalGate,
} from "../src/prompt-programs.js";

const fileContent = (entry: ProgramRegistryEntry): string =>
  readFileSync(programFilePath(entry), "utf8");

const expectFailureTag = async (
  effect: Effect.Effect<unknown, ProgramError>,
): Promise<ProgramError> => await Effect.runPromise(Effect.flip(effect));

describe("p6-prompt-programs", () => {
  // P8-010: the shared registry also hosts the P8 program families; this
  // suite stays scoped to the four P6 families.
  const p6Registry = PROGRAM_REGISTRY.filter((entry) =>
    entry.familyId.startsWith("p6-"),
  );

  for (const entry of p6Registry) {
    describe(entry.familyId, () => {
      it("carries a complete dual version header", async () => {
        const program = await Effect.runPromise(loadProgram(entry.familyId));
        expect(program.meta.familyId).toBe(entry.familyId);
        expect(program.meta.contractRevision).toBe("P6-05@1");
        expect(program.meta.textVersion).toBe(entry.textVersion);
        expect(program.meta.textHash).toMatch(/^[0-9a-f]{64}$/);
        expect(program.meta.changelog.length).toBeGreaterThan(0);
      });

      it("verifies textHash against the sha256 of its body", async () => {
        const program = await Effect.runPromise(loadProgram(entry.familyId));
        expect(sha256Hex(program.text)).toBe(program.meta.textHash);
      });

      it("contains every mandatory clause of P6-05 section 2", async () => {
        const results = await Effect.runPromise(evalAllPrograms());
        const result = results.find(
          (candidate) => candidate.familyId === entry.familyId,
        );
        expect(result?.missingClauses).toEqual([]);
        expect(result?.presentForbidden).toEqual([]);
        expect(result?.headerComplete).toBe(true);
        expect(result?.versionGate).toBe(true);
        expect(result?.hashMatches).toBe(true);
        expect(result?.passed).toBe(true);
      });
    });
  }

  it("forbids the invented Deliver kind and preemption wording in communication", async () => {
    const program = await Effect.runPromise(loadProgram("p6-communication"));
    expect(program.text).not.toContain("Deliver");
    expect(program.text).not.toContain("preempt");
  });

  it("keeps the human gate requirement in formation", async () => {
    const program = await Effect.runPromise(loadProgram("p6-formation"));
    expect(program.text).toContain("human gate");
    expect(program.text).not.toContain("self-execute first layer");
  });

  it("keeps the CanonicalInstruction/DataOnly distinction in bootstrap", async () => {
    const program = await Effect.runPromise(loadProgram("p6-bootstrap"));
    expect(program.text).toContain("CanonicalInstruction");
    expect(program.text).toContain("DataOnly");
  });

  it("keeps severity semantics in human-steer", async () => {
    const program = await Effect.runPromise(loadProgram("p6-human-steer"));
    expect(program.text).toContain("Normal does not change execution pace");
    expect(program.text).toContain("After a Critical steer");
    expect(program.text).toContain(
      "first action is to re-read the Canonical Control surface",
    );
  });

  it("rejects a tampered body with a typed hash mismatch", async () => {
    const entry = PROGRAM_REGISTRY[0] as ProgramRegistryEntry;
    const tampered = fileContent(entry).replace(
      "# Responsibility Formation",
      "# Tampered Formation",
    );
    expect(tampered).not.toBe(fileContent(entry));
    const error = await expectFailureTag(
      loadProgramContent(entry.familyId, tampered),
    );
    expect(error._tag).toBe("ProgramHashMismatch");
  });

  it("rejects an incomplete header with a typed header error", async () => {
    const entry = PROGRAM_REGISTRY[1] as ProgramRegistryEntry;
    const noHash = fileContent(entry)
      .split("\n")
      .filter((line) => !line.startsWith("textHash:"))
      .join("\n");
    const error = await expectFailureTag(
      loadProgramContent(entry.familyId, noHash),
    );
    expect(error._tag).toBe("ProgramHeaderInvalid");
  });

  it("fails the eval gate when registry and file textVersion disagree", () => {
    const entry = PROGRAM_REGISTRY[2] as ProgramRegistryEntry;
    const shiftedEntry: ProgramRegistryEntry = {
      ...entry,
      textVersion: entry.textVersion + 1,
    };
    const result = evaluateProgramContent(shiftedEntry, fileContent(entry));
    expect(result.versionGate).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("fails the eval gate when a mandatory clause is missing", () => {
    const entry = PROGRAM_REGISTRY[3] as ProgramRegistryEntry;
    const result = evaluateProgramContent(entry, "# Heading\n\nbody only");
    expect(result.passed).toBe(false);
    expect(result.missingClauses.length).toBeGreaterThan(0);
  });

  it("enforces the E4 version gate on load", async () => {
    const current = await Effect.runPromise(verifyEvalGate("p6-formation", 1));
    expect(current).toBe(true);
    const stale = await Effect.runPromise(verifyEvalGate("p6-formation", 2));
    expect(stale).toBe(false);
  });

  it("passes the program gate across all four families", async () => {
    const report = await Effect.runPromise(assertProgramGate());
    expect(report.passed).toBe(true);
    expect(
      report.results.filter((result) => result.familyId.startsWith("p6-")),
    ).toHaveLength(4);
  });
});
