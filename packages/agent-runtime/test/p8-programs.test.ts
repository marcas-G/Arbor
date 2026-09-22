import { readFileSync } from "node:fs";
import {
  Actor,
  CommandId,
  ExecutionId,
  FormationProposalId,
  type FormationProposalRecord,
  Principal,
  ProjectId,
  parse,
  type ResourceBoundary,
  type ResponsibilityDefinition,
  VerificationId,
  type VerificationMission,
  type Work,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../../application/src/command-result.js";
import {
  makeStartVerificationHandler,
  type StartVerificationPayload,
  type StartVerificationResult,
} from "../../application/src/commands/start-verification.js";
import {
  deriveFormationIds,
  formationAssignPlan,
} from "../../application/src/formation-plan.js";
import type {
  CommandOutcome,
  GatewayEnvelope,
} from "../../application/src/gateway.js";
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

const p8Entries = PROGRAM_REGISTRY.filter((entry) =>
  entry.familyId.startsWith("p8-"),
);

const p6Entries = PROGRAM_REGISTRY.filter((entry) =>
  entry.familyId.startsWith("p6-"),
);

describe("p8-programs", () => {
  for (const entry of p8Entries) {
    describe(entry.familyId, () => {
      it("carries a complete dual version header", async () => {
        const program = await Effect.runPromise(loadProgram(entry.familyId));
        expect(program.meta.familyId).toBe(entry.familyId);
        expect(program.meta.contractRevision).toBe(entry.contractRevision);
        expect(program.meta.contractRevision).toMatch(/^P8-0[25]@1$/);
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
    const program = await Effect.runPromise(loadProgram("p8-query-inspection"));
    const flat = program.text.replace(/\s+/g, " ");
    expect(flat).toContain("This execution is read-only");
    expect(flat).toContain("never as a change to canonical state");
    expect(flat).toContain("cites its source");
    expect(flat).toContain("declaring scope");
  });

  it("query-inspection carries no write-instruction wording", async () => {
    const program = await Effect.runPromise(loadProgram("p8-query-inspection"));
    for (const phrase of ["mutate", "insert", "upsert", "delete"]) {
      expect(program.text).not.toContain(phrase);
    }
  });

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
  });

  it("keeps the P6 families green after the registry extension", async () => {
    const results = await Effect.runPromise(evalAllPrograms());
    for (const entry of p6Entries) {
      const result = results.find(
        (candidate) => candidate.familyId === entry.familyId,
      );
      expect(result?.passed).toBe(true);
      expect(result?.versionGate).toBe(true);
      const program = await Effect.runPromise(loadProgram(entry.familyId));
      expect(program.meta.contractRevision).toBe("P6-05@1");
    }
  });

  it("passes the program gate across all six families", async () => {
    const report = await Effect.runPromise(assertProgramGate());
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(6);
  });

  it("rejects a tampered p8 body with a typed hash mismatch", async () => {
    const entry = p8Entries[0] as ProgramRegistryEntry;
    const tampered = fileContent(entry).replace(
      "# Verification Program",
      "# Tampered Verification",
    );
    expect(tampered).not.toBe(fileContent(entry));
    const error = await expectFailureTag(
      loadProgramContent(entry.familyId, tampered),
    );
    expect(error._tag).toBe("ProgramHashMismatch");
  });

  it("rejects an incomplete p8 header with a typed header error", async () => {
    const entry = p8Entries[1] as ProgramRegistryEntry;
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
    const entry = p8Entries[0] as ProgramRegistryEntry;
    const shiftedEntry: ProgramRegistryEntry = {
      ...entry,
      textVersion: entry.textVersion + 1,
    };
    const result = evaluateProgramContent(shiftedEntry, fileContent(entry));
    expect(result.versionGate).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("fails the eval gate when a mandatory clause is missing", () => {
    const entry = p8Entries[1] as ProgramRegistryEntry;
    const result = evaluateProgramContent(entry, "# Heading\n\nbody only");
    expect(result.passed).toBe(false);
    expect(result.missingClauses.length).toBeGreaterThan(0);
  });

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

  it("enforces the E4 version gate on load for both P8 families", async () => {
    for (const familyId of [
      "p8-verification",
      "p8-query-inspection",
    ] as const) {
      const current = await Effect.runPromise(verifyEvalGate(familyId, 1));
      expect(current).toBe(true);
      const stale = await Effect.runPromise(verifyEvalGate(familyId, 2));
      expect(stale).toBe(false);
    }
  });

  describe("M-2 placeholder mission migration", () => {
    const ACTOR = parse(Actor)("user:gov");
    const PRINCIPAL = parse(Principal)("user:gov");
    const PROJECT = parse(ProjectId)(
      "prj_00000000-0000-7000-8000-0000000000a1",
    );
    const PARENT = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-0000000000a2",
    );
    const WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a3");
    const COMMAND = parse(CommandId)(
      "cmd_00000000-0000-7000-8000-0000000000a4",
    );
    const VERIFICATION = parse(VerificationId)(
      "ver_00000000-0000-7000-8000-0000000000a5",
    );
    const EXECUTION = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-0000000000a6",
    );
    const PROPOSAL = parse(FormationProposalId)(
      "fpr_00000000-0000-7000-8000-0000000000a7",
    );

    const approvedSnapshot = (): FormationProposalRecord => ({
      proposalId: PROPOSAL,
      parentWorkspaceId: PARENT,
      proposal: {
        name: "child",
        rationale: "r",
        responsibilityDraft: {} as ResponsibilityDefinition,
        resourceBoundaryDraft: {} as ResourceBoundary,
        initialWork: {
          objective: "o",
          why: "w",
          constraints: [],
          completionExpectation: "c",
        },
      },
      revision: 1,
      state: "Approved",
    });

    const placeholderMission = (): VerificationMission => {
      const plan = formationAssignPlan({
        snapshot: approvedSnapshot(),
        ids: deriveFormationIds(PROPOSAL, 1),
        projectId: PROJECT,
        actor: ACTOR,
        principal: PRINCIPAL,
      });
      expect(plan).not.toBeNull();
      return (plan as NonNullable<typeof plan>).payload.verificationMission;
    };

    const legacyMission: VerificationMission = {
      goal: "p6-placeholder",
      criteria: [],
      riskRequirements: [],
    };

    const runStartVerification = (mission: VerificationMission) => {
      const work: Work = {
        workId: WORK,
        projectId: PROJECT,
        workspaceId: PARENT,
        objective: "o",
        why: "w",
        constraints: [],
        completionExpectation: "c",
        verificationMission: mission,
        provenance: { predecessorWorkId: null, reason: "p8-programs" },
        lifecycle: "Open",
        revision: parse(WorkRevision)(0),
      };
      const handler = makeStartVerificationHandler({
        works: {
          findById: () => Effect.succeed(Option.some(work)),
        },
        verifications: {
          findOpenByWorkRevision: () => Effect.succeed(Option.none()),
          insert: () => Effect.succeed(undefined),
        },
        deliverables: {
          findById: () => Effect.die(new Error("unused")),
          listArtifacts: () => Effect.die(new Error("unused")),
        },
        environmentRevisions: {
          current: () => Effect.die(new Error("unused")),
        },
      });
      const envelope: GatewayEnvelope<StartVerificationPayload> = {
        commandType: "StartVerification",
        commandId: COMMAND,
        projectId: PROJECT,
        actor: ACTOR,
        issuedAt: "t",
        payload: {
          verificationId: VERIFICATION,
          workId: WORK,
          observedWorkRevision: parse(WorkRevision)(0),
          missionSnapshot: mission,
          verifierExecutionId: EXECUTION,
          executableMission: false,
        },
      };
      return Effect.provideService(
        handler.execute(envelope, { _tag: "External", principal: PRINCIPAL }),
        TransactionScope,
        { session: { id: "p8-programs" } },
      );
    };

    it("formation emits the structured minimal placeholder mission", () => {
      expect(placeholderMission()).toEqual({
        goal: "formation-assigned work",
        criteria: [
          {
            criterionId: "acceptance",
            requirement: "parent acceptance",
            required: true,
          },
        ],
        riskRequirements: [],
      });
    });

    it("StartVerification accepts the formation placeholder mission", async () => {
      const outcome: CommandResult<CommandOutcome<StartVerificationResult>> =
        await Effect.runPromise(runStartVerification(placeholderMission()));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.value.result.state).toBe("Open");
        expect(outcome.value.result.verifierExecutionId).toBe(EXECUTION);
        expect(outcome.value.events).toHaveLength(1);
        expect(outcome.value.events[0]?.eventType).toBe("VerificationStarted");
      }
    });

    it("StartVerification typed-rejects the legacy p6-placeholder mission", async () => {
      const outcome = await Effect.runPromise(
        runStartVerification(legacyMission),
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error._tag).toBe("InvalidVerificationMission");
      }
    });
  });
});
