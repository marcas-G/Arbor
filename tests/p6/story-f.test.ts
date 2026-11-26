import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertProgramGate,
  evalAllPrograms,
  evaluateProgramContent,
  loadProgram,
  PROGRAM_REGISTRY,
  type ProgramRegistryEntry,
  programFilePath,
} from "../../packages/agent-runtime/src/prompt-programs.js";

describe("p6-acceptance", () => {
  it("Story F: prompt program version discipline (D4)", async () => {
    // P8-010: the shared registry now also hosts the P8 program families;
    // this story stays scoped to the four P6 families.
    const results = (await Effect.runPromise(evalAllPrograms())).filter(
      (result) => result.familyId.startsWith("p6-"),
    );
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.passed).toBe(true);
      expect(result.missingClauses).toEqual([]);
      expect(result.presentForbidden).toEqual([]);
      expect(result.versionGate).toBe(true);
      expect(result.hashMatches).toBe(true);
    }

    for (const entry of PROGRAM_REGISTRY.filter((candidate) =>
      candidate.familyId.startsWith("p6-"),
    )) {
      const program = await Effect.runPromise(loadProgram(entry.familyId));
      expect(program.meta.familyId).toBe(entry.familyId);
      expect(program.meta.contractRevision).toBe("P6-05@1");
      expect(program.meta.textVersion).toBe(entry.textVersion);
      expect(program.meta.textHash).toMatch(/^[0-9a-f]{64}$/);
      const fileContent = readFileSync(programFilePath(entry), "utf8");
      expect(fileContent).toMatch(/^contractRevision:/m);
      expect(fileContent).toMatch(/^textVersion:/m);
      expect(fileContent).toMatch(/^textHash:/m);
    }

    const gate = await Effect.runPromise(assertProgramGate());
    expect(gate.passed).toBe(true);
    expect(
      gate.results.filter((r) => r.familyId.startsWith("p6-")),
    ).toHaveLength(4);

    const formation = PROGRAM_REGISTRY.find(
      (entry) => entry.familyId === "p6-formation",
    ) as ProgramRegistryEntry;
    const bumped: ProgramRegistryEntry = {
      ...formation,
      textVersion: formation.textVersion + 1,
    };
    const bumpedResult = evaluateProgramContent(
      bumped,
      readFileSync(programFilePath(formation), "utf8"),
    );
    expect(bumpedResult.versionGate).toBe(false);
    expect(bumpedResult.passed).toBe(false);

    const communication = PROGRAM_REGISTRY.find(
      (entry) => entry.familyId === "p6-communication",
    ) as ProgramRegistryEntry;
    const tampered = readFileSync(programFilePath(communication), "utf8")
      .split("\n")
      .filter((line) => !line.includes("A Report is not a delivery"))
      .join("\n");
    const tamperedResult = evaluateProgramContent(communication, tampered);
    expect(tamperedResult.missingClauses).toContain(
      "A Report is not a delivery",
    );
    expect(tamperedResult.passed).toBe(false);
  });
});
