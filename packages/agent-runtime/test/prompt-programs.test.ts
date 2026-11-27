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

const p6Entries = PROGRAM_REGISTRY.filter((entry) =>
  entry.familyId.startsWith("p6-"),
);
const p8Entries = PROGRAM_REGISTRY.filter((entry) =>
  entry.familyId.startsWith("p8-"),
);

// The per-family loop covers every registry family (P8-010: the shared
// registry hosts both program families); the family-specific content
// contracts stay as focused tests below.
describe("-prompt-programs", () => {
  for (const entry of PROGRAM_REGISTRY) {
    describe(entry.familyId, () => {
      it("carries a complete dual version header", async () => {
        const program = await Effect.runPromise(loadProgram(entry.familyId));
        expect(program.meta.familyId).toBe(entry.familyId);
        expect(program.meta.contractRevision).toBe(entry.contractRevision);
        expect(program.meta.textVersion).toBe(entry.textVersion);
        expect(program.meta.textHash).toMatch(/^[0-9a-f]{64}$/);
        expect(program.meta.changelog.length).toBeGreaterThan(0);
      });

      it("verifies textHash against the sha256 of its body", async () => {
        const program = await Effect.runPromise(loadProgram(entry.familyId));
        expect(sha256Hex(program.text)).toBe(program.meta.textHash);
      });

      it("contains every mandatory clause and no forbidden phrase", async () => {
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

  it("registers the two P8 families beside the four P6 families", () => {
    expect(PROGRAM_REGISTRY).toHaveLength(6);
    expect(p8Entries.map((entry) => entry.familyId)).toEqual([
      "p8-verification",
      "p8-query-inspection",
    ]);
    expect(p6Entries.map((entry) => entry.familyId)).toEqual([
      "p6-formation",
      "p6-communication",
      "p6-bootstrap",
      "p6-human-steer",
    ]);
    for (const entry of p6Entries)
      expect(entry.contractRevision).toBe("P6-05@1");
    expect(p8Entries.map((entry) => entry.contractRevision)).toEqual([
      "P8-02@1",
      "P8-05@1",
    ]);
  });

  it("passes the program gate across all six families", async () => {
    const report = await Effect.runPromise(assertProgramGate());
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(6);
  });

  it.each(PROGRAM_REGISTRY)(
    "rejects a tampered $familyId body with a typed hash mismatch",
    async (entry) => {
      const tampered = `${fileContent(entry)}# tampered epilogue\n`;
      expect(tampered).not.toBe(fileContent(entry));
      const error = await expectFailureTag(
        loadProgramContent(entry.familyId, tampered),
      );
      expect(error._tag).toBe("ProgramHashMismatch");
    },
  );

  it.each(PROGRAM_REGISTRY)(
    "rejects an incomplete $familyId header with a typed header error",
    async (entry) => {
      const noHash = fileContent(entry)
        .split("\n")
        .filter((line) => !line.startsWith("textHash:"))
        .join("\n");
      const error = await expectFailureTag(
        loadProgramContent(entry.familyId, noHash),
      );
      expect(error._tag).toBe("ProgramHeaderInvalid");
    },
  );

  it.each(PROGRAM_REGISTRY)(
    "fails the eval gate when registry and file textVersion disagree",
    (entry) => {
      const shiftedEntry: ProgramRegistryEntry = {
        ...entry,
        textVersion: entry.textVersion + 1,
      };
      const result = evaluateProgramContent(shiftedEntry, fileContent(entry));
      expect(result.versionGate).toBe(false);
      expect(result.passed).toBe(false);
    },
  );

  it.each(PROGRAM_REGISTRY)(
    "fails the eval gate when a mandatory clause is missing",
    (entry) => {
      const result = evaluateProgramContent(entry, "# Heading\n\nbody only");
      expect(result.passed).toBe(false);
      expect(result.missingClauses.length).toBeGreaterThan(0);
    },
  );

  it.each(PROGRAM_REGISTRY)(
    "enforces the E4 version gate on load for $familyId",
    async (entry) => {
      const current = await Effect.runPromise(
        verifyEvalGate(entry.familyId, entry.textVersion),
      );
      expect(current).toBe(true);
      const stale = await Effect.runPromise(
        verifyEvalGate(entry.familyId, entry.textVersion + 1),
      );
      expect(stale).toBe(false);
    },
  );

  it("fails the eval gate on a synthetic read-only negative clause", () => {
    const entry = p8Entries[1] as ProgramRegistryEntry;
    const writer: ProgramRegistryEntry = {
      ...entry,
      mandatoryClauses: ["a query result may upsert canonical state"],
    };
    const result = evaluateProgramContent(writer, fileContent(entry));
    expect(result.missingClauses).toEqual([
      "a query result may upsert canonical state",
    ]);
    expect(result.passed).toBe(false);
  });

  describe("P6 content contracts", () => {
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
  });

  describe("P8 content contracts", () => {
    it("verification states the honest three-value duty in plain words", async () => {
      const program = await Effect.runPromise(loadProgram("p8-verification"));
      const flat = program.text.replace(/\s+/g, " ");
      expect(flat).toContain("Finding no problem is not Pass");
      expect(flat).toContain("exactly one verdict of Pass, Fail, or Unknown");
      expect(flat).toContain("insufficient evidence");
      expect(flat).toContain(
        "The Verifier judges; the Producer fixes; the Parent accepts",
      );
      expect(flat).toContain("evidence reference");
    });

    it("verification carries no auto-pass or silently pass wording", async () => {
      const program = await Effect.runPromise(loadProgram("p8-verification"));
      expect(program.text).not.toContain("auto-pass");
      expect(program.text).not.toContain("silently pass");
    });

    it("query-inspection states read-only discipline and message-only results", async () => {
      const program = await Effect.runPromise(
        loadProgram("p8-query-inspection"),
      );
      const flat = program.text.replace(/\s+/g, " ");
      expect(flat).toContain("This execution is read-only");
      expect(flat).toContain("never as a change to canonical state");
      expect(flat).toContain("cites its source");
      expect(flat).toContain("declaring scope");
    });

    it("query-inspection carries no write-instruction wording", async () => {
      const program = await Effect.runPromise(
        loadProgram("p8-query-inspection"),
      );
      for (const phrase of ["mutate", "insert", "upsert", "delete"]) {
        expect(program.text).not.toContain(phrase);
      }
    });
  });
});
