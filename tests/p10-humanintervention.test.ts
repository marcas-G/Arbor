import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type AcceptWorkOutcomePayload,
  makeAcceptWorkOutcomeHandler,
} from "../packages/application/src/commands/accept-complete.js";
import {
  type MarkDependencyUnfulfillablePayload,
  makeMarkDependencyUnfulfillableHandler,
  makeWithdrawDependencyHandler,
  type WithdrawDependencyPayload,
} from "../packages/application/src/commands/dependency-transitions.js";
import {
  makeRecordDecisionHandler,
  type RecordDecisionPayload,
} from "../packages/application/src/commands/record-decision.js";
import {
  makeSteerWorkHandler,
  type SteerWorkPayload,
} from "../packages/application/src/commands/steer-work.js";
import {
  HUMAN_STOP_EMISSION_PRECONDITION,
  humanStopInterventionEvent,
} from "../packages/application/src/human-intervention.js";
import {
  CommandGateway,
  type CommandGatewayService,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  admitFormationProposal,
  CommandId,
  Principal,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  DependencyRepository,
  FormationProposalStore,
  InboxProjectionStore,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

/** P10-010 — HumanInterventionApplied emission wiring (P10 `06` §2):
 * steer back-fill pairing, the four human-originated governance command
 * branches (agent submissions emit nothing), and the dormant wire-only
 * Stop branch. */

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);

const humanActor = p7TestActor;
const humanPrincipal = p7TestPrincipal;
const agentPrincipal = parse(Principal)("agent:bot");
const agentActor = parse(Actor)("agent:bot");

const VER_1 = parse(VerificationId)("ver_00000000-0000-7000-8000-000000000001");

const mission: VerificationMission = {
  goal: "g",
  criteria: [],
  riskRequirements: [],
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

// --- journal-level reads -----------------------------------------------------

const journalEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      event_type: string;
      payload_json: string;
      caused_by_command_id: string;
    }>(
      "SELECT event_type, payload_json, caused_by_command_id FROM domain_events WHERE event_type = ? ORDER BY sequence",
      [eventType],
    );
    return rows.map((row) => ({
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      causedByCommandId: row.caused_by_command_id,
    }));
  });

const journalCount = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.count ?? 0);
  });

// --- steer (real gateway — journal-level same-transaction pairing) ----------

const steerPayload = (
  severity: "Normal" | "Critical",
  revision: number,
): SteerWorkPayload => ({
  workId: WORK_1,
  workspaceId: p7RootWorkspace,
  steer: { severity, guidance: `cnt-steer-${severity}` },
  expectedWorkRevision: parse(WorkRevision)(revision),
  provenance: { source: "HumanInput" },
});

const submitSteer = (
  gw: CommandGatewayService,
  commandId: CommandId,
  payload: SteerWorkPayload,
  principal: Principal = humanPrincipal,
  actor: Actor = humanActor,
) => {
  const authority: VerifiedCommandAuthority = {
    _tag: "SteerWorkAuthority",
    principal,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "SteerWork",
      projectId: p7Project,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId: p7Project,
    targetWorkspaceId: payload.workspaceId,
    workId: payload.workId,
  };
  return gw.execute(
    {
      commandType: "SteerWork",
      commandId,
      projectId: p7Project,
      actor,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal },
    authority,
  );
};

describe("P10-010 steer emission (P6 inherited evolution, 06 §2)", () => {
  it("human Normal steer: WorkSteered (frozen P6 shape) + HumanInterventionApplied(Steer) paired same-transaction (one causedByCommandId)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const commandId = CMD("0000000000b1");
        const receipt = yield* submitSteer(
          gw,
          commandId,
          steerPayload("Normal", 0),
        );
        expect(receipt.resolution._tag).toBe("Committed");
        const steered = yield* journalEvents("WorkSteered");
        const interventions = yield* journalEvents("HumanInterventionApplied");
        expect(steered).toHaveLength(1);
        expect(interventions).toHaveLength(1);
        expect(steered[0]!.payload).toEqual({
          workId: WORK_1,
          fromRevision: 0,
          toRevision: 1,
          severity: "Normal",
        });
        expect(interventions[0]!.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "cnt-steer-Normal",
          occurredAt: "t",
          kind: "Steer",
        });
        // Same-transaction pairing: both facts bind the same command id
        // (the gateway journals the handler's single events array inside
        // the command transaction).
        expect(steered[0]!.causedByCommandId).toBe(commandId);
        expect(interventions[0]!.causedByCommandId).toBe(commandId);
      }),
      makeP7App(),
    );
  });

  it("Critical steer emits kind=CriticalSteer; replay of the same commandId adds zero facts (fire-once by receipt)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const commandId = CMD("0000000000b2");
        const first = yield* submitSteer(
          gw,
          commandId,
          steerPayload("Critical", 0),
        );
        expect(first.resolution._tag).toBe("Committed");
        const replay = yield* submitSteer(
          gw,
          commandId,
          steerPayload("Critical", 0),
        );
        // Fire-once by command receipt: the replay settles as the same
        // stored Committed resolution and adds zero facts (ClockLive
        // timestamps differ, so compare the semantic fields).
        expect(replay.commandId).toBe(first.commandId);
        expect(replay.resolution._tag).toBe("Committed");
        expect(replay.resolution).toEqual(first.resolution);
        const interventions = yield* journalEvents("HumanInterventionApplied");
        expect(interventions).toHaveLength(1);
        expect(interventions[0]!.payload.kind).toBe("CriticalSteer");
        expect(yield* journalCount("WorkSteered")).toBe(1);
      }),
      makeP7App(),
    );
  });

  it("agent-principal steer is rejected before mutation: zero events of either type", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const receipt = yield* submitSteer(
          gw,
          CMD("0000000000b3"),
          steerPayload("Normal", 0),
          agentPrincipal,
          agentActor,
        );
        expect(receipt.resolution._tag).toBe("TerminalRejected");
        expect(yield* journalCount("WorkSteered")).toBe(0);
        expect(yield* journalCount("HumanInterventionApplied")).toBe(0);
      }),
      makeP7App(),
    );
  });
});

// --- governance four (handler-driven in the store transaction) ---------------

const interventionFactsOf = (outcome: {
  value: {
    events: ReadonlyArray<{
      eventType: string;
      payload: unknown;
      causedByCommandId?: unknown;
    }>;
  };
}) =>
  outcome.value.events.filter(
    (event) => event.eventType === "HumanInterventionApplied",
  );

describe("P10-010 governance emission set (four human-originated commands)", () => {
  it("RecordDecision (formation approval): human branch pairs DecisionRecorded + HumanInterventionApplied(GovernanceDecision); agent branch emits nothing", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const proposals = yield* FormationProposalStore;
        const inbox = yield* InboxProjectionStore;
        const proposalOf = (id: string) =>
          admitFormationProposal({
            proposalId: id as never,
            parentWorkspaceId: p7RootWorkspace,
            proposal: {
              name: "child",
              responsibilityDraft: {
                purpose: "p",
                ownedResponsibilities: [],
                obligations: [],
                includes: [],
                excludes: [],
                interfaces: [],
              },
              resourceBoundaryDraft: {
                basisResponsibilityRevision: 0 as never,
                addresses: [],
              },
              rationale: "p10-010",
            },
          });
        const humanRecord = proposalOf(
          "fpr_00000000-0000-7000-8000-000000000001",
        );
        const agentRecord = proposalOf(
          "fpr_00000000-0000-7000-8000-000000000002",
        );
        yield* tx.transact(proposals.insert(humanRecord));
        yield* tx.transact(proposals.insert(agentRecord));
        const handler = makeRecordDecisionHandler({
          proposals,
          inbox,
          originatingWorkspaceOf: (r) => r.parentWorkspaceId,
        });
        const payload = (
          proposalId: string,
          outcome: "Approve" | "Reject",
        ): RecordDecisionPayload => ({
          proposalId: proposalId as never,
          expectedProposalRevision: 1,
          outcome: { _tag: outcome },
        });
        const envelopeOf = (
          commandId: CommandId,
          p: RecordDecisionPayload,
          actor: Actor,
        ) => ({
          commandType: "RecordDecision",
          commandId,
          projectId: p7Project,
          actor,
          issuedAt: "t",
          payload: p,
        });

        const human = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0000000000c1"),
              payload(humanRecord.proposalId, "Approve"),
              humanActor,
            ),
            {
              _tag: "External",
              principal: humanPrincipal,
            },
          ),
        );
        expect(human.ok).toBe(true);
        if (human.ok) {
          expect(human.value.events).toHaveLength(2);
          expect(human.value.events[0]!.eventType).toBe("DecisionRecorded");
          const fact = interventionFactsOf(human)[0]!;
          expect(fact.payload).toEqual({
            actor: humanActor,
            targetWorkspaceId: p7RootWorkspace,
            summaryRef:
              "formation proposal fpr_00000000-0000-7000-8000-000000000001 approved at revision 1",
            occurredAt: "t",
            kind: "GovernanceDecision",
          });
          expect(fact.causedByCommandId).toBe(CMD("0000000000c1"));
          expect(human.value.events[0]!.causedByCommandId).toBe(
            CMD("0000000000c1"),
          );
        }

        const agent = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0000000000c2"),
              payload(agentRecord.proposalId, "Reject"),
              agentActor,
            ),
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agent.ok).toBe(true);
        if (agent.ok) {
          expect(agent.value.events).toHaveLength(1);
          expect(interventionFactsOf(agent)).toHaveLength(0);
        }
      }),
      makeP7App(),
    );
  });

  it("AcceptWorkOutcome human branch pairs WorkOutcomeAccepted + the fact (target = work's workspace)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const verifications = yield* VerificationRepository;
        const acceptances = yield* AcceptanceRepository;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER_1,
              workId: WORK_1,
              targetWorkRevision: parse(WorkRevision)(0),
              missionSnapshot: mission,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* tx.transact(
          verifications.concludeIfOpen(VER_1, "Pass", undefined),
        );
        const handler = makeAcceptWorkOutcomeHandler({
          works,
          verifications,
          acceptances,
        });
        const payload: AcceptWorkOutcomePayload = {
          acceptanceId: "acc_00000000-0000-7000-8000-000000000001" as never,
          workId: WORK_1,
          targetWorkRevision: parse(WorkRevision)(0),
          verificationId: VER_1,
        };
        const human = yield* tx.transact(
          handler.execute(
            {
              commandType: "AcceptWorkOutcome",
              commandId: CMD("0000000000d1"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(human.ok).toBe(true);
        if (human.ok) {
          expect(human.value.events).toHaveLength(2);
          expect(human.value.events[0]!.eventType).toBe("WorkOutcomeAccepted");
          const fact = interventionFactsOf(human)[0]!;
          expect(fact.payload).toEqual({
            actor: humanActor,
            targetWorkspaceId: p7RootWorkspace,
            summaryRef: `work outcome accepted: ${WORK_1} at revision 0`,
            occurredAt: "t",
            kind: "GovernanceDecision",
          });
          expect(fact.causedByCommandId).toBe(CMD("0000000000d1"));
        }
      }),
      makeP7App(),
    );
  });

  it("AcceptWorkOutcome agent submission commits the acceptance with zero intervention facts", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const verifications = yield* VerificationRepository;
        const acceptances = yield* AcceptanceRepository;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER_1,
              workId: WORK_1,
              targetWorkRevision: parse(WorkRevision)(0),
              missionSnapshot: mission,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* tx.transact(
          verifications.concludeIfOpen(VER_1, "Pass", undefined),
        );
        const handler = makeAcceptWorkOutcomeHandler({
          works,
          verifications,
          acceptances,
        });
        const agent = yield* tx.transact(
          handler.execute(
            {
              commandType: "AcceptWorkOutcome",
              commandId: CMD("0000000000d2"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: {
                acceptanceId: "acc_00000000-0000-7000-8000-000000000002",
                workId: WORK_1,
                targetWorkRevision: parse(WorkRevision)(0),
                verificationId: VER_1,
              } as AcceptWorkOutcomePayload,
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agent.ok).toBe(true);
        if (agent.ok) {
          expect(agent.value.events).toHaveLength(1);
          expect(agent.value.events[0]!.eventType).toBe("WorkOutcomeAccepted");
          expect(interventionFactsOf(agent)).toHaveLength(0);
        }
      }),
      makeP7App(),
    );
  });

  it("WithdrawDependency / MarkDependencyUnfulfillable: human branches emit the fact (target = consumer workspace); agent branches emit nothing", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        const dependencies = yield* DependencyRepository;
        const works = yield* WorkRepository;
        const seedDependency = (dependencyId: string) =>
          sql.unsafe(
            "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
              dependencyId,
              p7Project,
              WORK_1,
              JSON.stringify({
                _tag: "WorkspaceBound",
                workspaceId: p7RootWorkspace,
              }),
              JSON.stringify({ kind: "report", requiredArtifactRoles: [] }),
              0,
              "Unsatisfied",
              null,
              null,
              "t0",
              "t0",
            ],
          );
        yield* seedDependency("dep_0000000000p10e1");
        yield* seedDependency("dep_0000000000p10e2");
        yield* seedDependency("dep_0000000000p10e3");
        yield* seedDependency("dep_0000000000p10e4");

        const withdraw = makeWithdrawDependencyHandler({
          dependencies,
          works,
        });
        const mark = makeMarkDependencyUnfulfillableHandler({
          dependencies,
          works,
        });

        const humanWithdraw = yield* tx.transact(
          withdraw.execute(
            {
              commandType: "WithdrawDependency",
              commandId: CMD("0000000000e1"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_0000000000p10e1",
                targetDependencyRevision: 0,
                reason: "no longer needed",
              } as WithdrawDependencyPayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanWithdraw.ok).toBe(true);
        if (humanWithdraw.ok) {
          expect(humanWithdraw.value.events).toHaveLength(2);
          const fact = interventionFactsOf(humanWithdraw)[0]!;
          expect(fact.payload).toMatchObject({
            targetWorkspaceId: p7RootWorkspace,
            kind: "GovernanceDecision",
            summaryRef:
              "dependency dep_0000000000p10e1 withdrawn: no longer needed",
          });
        }

        const agentWithdraw = yield* tx.transact(
          withdraw.execute(
            {
              commandType: "WithdrawDependency",
              commandId: CMD("0000000000e2"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_0000000000p10e2",
                targetDependencyRevision: 0,
                reason: "agent path",
              } as WithdrawDependencyPayload,
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agentWithdraw.ok).toBe(true);
        if (agentWithdraw.ok) {
          expect(agentWithdraw.value.events).toHaveLength(1);
          expect(interventionFactsOf(agentWithdraw)).toHaveLength(0);
        }

        const humanMark = yield* tx.transact(
          mark.execute(
            {
              commandType: "MarkDependencyUnfulfillable",
              commandId: CMD("0000000000e3"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_0000000000p10e3",
                targetDependencyRevision: 0,
                justification: "confirmed unfulfillable",
              } as MarkDependencyUnfulfillablePayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanMark.ok).toBe(true);
        if (humanMark.ok) {
          expect(humanMark.value.events).toHaveLength(2);
          const fact = interventionFactsOf(humanMark)[0]!;
          expect(fact.payload).toMatchObject({
            targetWorkspaceId: p7RootWorkspace,
            kind: "GovernanceDecision",
            summaryRef:
              "dependency dep_0000000000p10e3 marked unfulfillable: confirmed unfulfillable",
          });
        }

        const agentMark = yield* tx.transact(
          mark.execute(
            {
              commandType: "MarkDependencyUnfulfillable",
              commandId: CMD("0000000000e4"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_0000000000p10e4",
                targetDependencyRevision: 0,
                justification: "agent adjudication",
              } as MarkDependencyUnfulfillablePayload,
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agentMark.ok).toBe(true);
        if (agentMark.ok) {
          expect(agentMark.value.events).toHaveLength(1);
          expect(interventionFactsOf(agentMark)).toHaveLength(0);
        }
      }),
      makeP7App(),
    );
  });
});

// --- dormant Stop branch (wire-only) -----------------------------------------

describe("P10-010 dormant Stop branch (wire-only, 06 §2)", () => {
  it("declares the frozen precondition and the payload-shaped Stop fact builder", () => {
    expect(HUMAN_STOP_EMISSION_PRECONDITION).toBe(
      "resolver-admitted (P12, GQ4)",
    );
    const event = humanStopInterventionEvent({
      projectId: p7Project,
      commandId: CMD("0000000000f1"),
      actor: humanActor,
      targetWorkspaceId: p7RootWorkspace,
      summaryRef: "stop reason",
      occurredAt: "t",
    });
    expect(event.eventType).toBe("HumanInterventionApplied");
    expect(event.payload).toEqual({
      actor: humanActor,
      targetWorkspaceId: p7RootWorkspace,
      summaryRef: "stop reason",
      occurredAt: "t",
      kind: "Stop",
    });
  });

  it("zero production call sites: no src file outside the helper invokes the dormant Stop builder, and no StopExecution mutation runs in this suite", async () => {
    const repoRoot = join(import.meta.dirname, "..");
    const packagesDir = join(repoRoot, "packages");
    const offenders: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "dist" || entry.name === "node_modules") {
            continue;
          }
          walk(path);
        } else if (entry.name.endsWith(".ts")) {
          const source = readFileSync(path, "utf8");
          if (path.endsWith("human-intervention.ts")) {
            continue;
          }
          if (source.includes("humanStopInterventionEvent")) {
            offenders.push(path);
          }
        }
      }
    };
    walk(packagesDir);
    expect(offenders).toEqual([]);
    // Wire-only also means the execution-runtime Stop path stays
    // untouched: its handler source carries no intervention import.
    const stopHandler = readFileSync(
      join(
        repoRoot,
        "packages/execution-runtime/src/commands/stop-execution.ts",
      ),
      "utf8",
    );
    expect(stopHandler.includes("human-intervention")).toBe(false);
  });
});
