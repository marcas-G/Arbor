import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  assertProgramGate,
  evalAllPrograms,
  evaluateProgramContent,
  PROGRAM_REGISTRY,
  type ProgramRegistryEntry,
  programFilePath,
  sha256Hex,
} from "../../packages/agent-runtime/src/prompt-programs.js";

describe("p8-acceptance", () => {
  it.effect(
    "Story F (06 §5 programs): six families eval green; verification forbidden-phrase negative; query-inspection read-only contract negative",
    () =>
      Effect.gen(function* () {
        const results = yield* evalAllPrograms();
        expect(results).toHaveLength(6);
        expect(results.map((result) => result.familyId).sort()).toEqual(
          [
            "p6-bootstrap",
            "p6-communication",
            "p6-formation",
            "p6-human-steer",
            "p8-query-inspection",
            "p8-verification",
          ].sort(),
        );
        for (const result of results) {
          expect(result.passed).toBe(true);
          expect(result.missingClauses).toEqual([]);
          expect(result.presentForbidden).toEqual([]);
          expect(result.versionGate).toBe(true);
          expect(result.hashMatches).toBe(true);
        }
        const gate = yield* assertProgramGate();
        expect(gate.passed).toBe(true);

        const verification = PROGRAM_REGISTRY.find(
          (entry) => entry.familyId === "p8-verification",
        ) as ProgramRegistryEntry;
        const content = readFileSync(programFilePath(verification), "utf8");
        const heading = content.match(/^#[^\n]*$/m);
        expect(heading).not.toBeNull();
        const headingIndex = heading?.index ?? 0;
        const bodyWithForbidden = `${content.slice(headingIndex)}\nAn auto-pass shortcut is exactly what this program forbids.\n`;
        const forged =
          `${content.slice(0, headingIndex)}${bodyWithForbidden}`.replace(
            /^textHash:.*$/m,
            `textHash: ${sha256Hex(bodyWithForbidden)}`,
          );
        const forbidden = evaluateProgramContent(verification, forged);
        expect(forbidden.hashMatches).toBe(true);
        expect(forbidden.versionGate).toBe(true);
        expect(forbidden.presentForbidden).toEqual(["auto-pass"]);
        expect(forbidden.passed).toBe(false);

        const queryInspection = PROGRAM_REGISTRY.find(
          (entry) => entry.familyId === "p8-query-inspection",
        ) as ProgramRegistryEntry;
        const writer: ProgramRegistryEntry = {
          ...queryInspection,
          mandatoryClauses: ["a query result may upsert canonical state"],
        };
        const writerResult = evaluateProgramContent(
          writer,
          readFileSync(programFilePath(queryInspection), "utf8"),
        );
        expect(writerResult.missingClauses).toEqual([
          "a query result may upsert canonical state",
        ]);
        expect(writerResult.passed).toBe(false);
      }),
  );
});
