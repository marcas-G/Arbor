import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  type AcceptWorkOutcomePayload,
  makeAcceptWorkOutcomeHandler,
} from "../../packages/application/src/commands/accept-complete.js";
import {
  type MarkDependencyUnfulfillablePayload,
  makeMarkDependencyUnfulfillableHandler,
  makeWithdrawDependencyHandler,
  type WithdrawDependencyPayload,
} from "../../packages/application/src/commands/dependency-transitions.js";
import {
  makeRecordDecisionHandler,
  type RecordDecisionPayload,
} from "../../packages/application/src/commands/record-decision.js";
import {
  HUMAN_STOP_EMISSION_PRECONDITION,
  humanStopInterventionEvent,
} from "../../packages/application/src/human-intervention.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import type { VerificationMission } from "../../packages/domain/dist/index.js";
import {
  Actor,
  admitFormationProposal,
  CommandId,
  Principal,
  parse,
  startVerification,
  VerificationId,
  WorkId,
  WorkRevision,
} from "../../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  DependencyRepository,
  FormationProposalStore,
  InboxProjectionStore,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
} from "../../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "../support/p7-app.js";

describe("p10-acceptance (P10 07 Stories A–G)", () => {
  it("Story F — Human intervention facts: steer both kinds paired same-transaction; four governance human branches emit the fact; agent submissions emit nothing; the Stop branch stays wire-only", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
    const assignCmd = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
    );
    const cmd = (suffix: string) =>
      parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
    const verificationId = parse(VerificationId)(
      "ver_00000000-0000-7000-8000-0000000000f1",
    );
    const mission: VerificationMission = {
      goal: "g",
      criteria: [
        {
          criterionId: "human-intervention-proof",
          requirement: "the intervention remains revision-bound",
          required: true,
        },
      ],
      riskRequirements: [],
    };
    const humanActor = p7TestActor;
    const humanPrincipal = p7TestPrincipal;
    const agentPrincipal = parse(Principal)("agent:bot");
    const agentActor = parse(Actor)("agent:bot");

    const seed = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* p7SeedProject;
      const receipt = yield* p7SeedWork(work, assignCmd);
      expect(receipt.resolution._tag).toBe("Committed");
    });

    const journalEvents = (eventType: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{
          payload_json: string;
          caused_by_command_id: string;
        }>(
          "SELECT payload_json, caused_by_command_id FROM domain_events WHERE event_type = ? ORDER BY sequence",
          [eventType],
        );
        return rows.map((row) => ({
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
          causedByCommandId: row.caused_by_command_id,
        }));
      });

    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;

        const steerPayload = (
          severity: "Normal" | "Critical",
          revision: number,
        ) => ({
          workId: work,
          workspaceId: p7RootWorkspace,
          steer: {
            severity,
            operation: {
              kind: "DirectionGuidance" as const,
              guidance: `cnt-acc-steer-${severity}`,
            },
          },
          expectedWorkRevision: parse(WorkRevision)(revision),
          provenance: { source: "HumanInput" as const },
        });
        const submitSteer = (
          commandId: CommandId,
          payload: ReturnType<typeof steerPayload>,
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
              schemaVersion: "2",
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

        const normalCmd = cmd("0000000000f1");
        const normal = yield* submitSteer(normalCmd, steerPayload("Normal", 0));
        expect(normal.resolution._tag).toBe("Committed");
        const criticalCmd = cmd("0000000000f2");
        const critical = yield* submitSteer(
          criticalCmd,
          steerPayload("Critical", 1),
        );
        expect(critical.resolution._tag).toBe("Committed");
        const agentSteer = yield* submitSteer(
          cmd("0000000000f3"),
          steerPayload("Normal", 2),
          agentPrincipal,
          agentActor,
        );
        expect(agentSteer.resolution._tag).toBe("TerminalRejected");

        const steered = yield* journalEvents("WorkSteered");
        const interventions = yield* journalEvents("HumanInterventionApplied");
        expect(steered).toHaveLength(2);
        expect(interventions).toHaveLength(2);
        expect(steered[0]?.payload).toEqual({
          workId: work,
          fromRevision: 0,
          toRevision: 1,
          severity: "Normal",
        });
        expect(steered[1]?.payload).toEqual({
          workId: work,
          fromRevision: 1,
          toRevision: 2,
          severity: "Critical",
        });
        expect(interventions[0]?.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "cnt-acc-steer-Normal",
          occurredAt: "t",
          kind: "Steer",
        });
        expect(interventions[1]?.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "cnt-acc-steer-Critical",
          occurredAt: "t",
          kind: "CriticalSteer",
        });
        expect(steered[0]?.causedByCommandId).toBe(normalCmd);
        expect(interventions[0]?.causedByCommandId).toBe(normalCmd);
        expect(steered[1]?.causedByCommandId).toBe(criticalCmd);
        expect(interventions[1]?.causedByCommandId).toBe(criticalCmd);

        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        const proposals = yield* FormationProposalStore;
        const inbox = yield* InboxProjectionStore;
        const works = yield* WorkRepository;
        const verifications = yield* VerificationRepository;
        const acceptances = yield* AcceptanceRepository;
        const dependencies = yield* DependencyRepository;

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
              rationale: "p10-acceptance",
            },
          });
        const humanProposal = proposalOf(
          "fpr_00000000-0000-7000-8000-0000000000f1",
        );
        const agentProposal = proposalOf(
          "fpr_00000000-0000-7000-8000-0000000000f2",
        );
        yield* tx.transact(proposals.insert(humanProposal));
        yield* tx.transact(proposals.insert(agentProposal));
        const recordDecision = makeRecordDecisionHandler({
          proposals,
          inbox,
          originatingWorkspaceOf: (record) => record.parentWorkspaceId,
        });
        const decisionPayload = (
          proposalId: string,
          outcome: "Approve" | "Reject",
        ): RecordDecisionPayload => ({
          proposalId: proposalId as never,
          expectedProposalRevision: 1,
          outcome: { _tag: outcome },
        });
        const humanDecision = yield* tx.transact(
          recordDecision.execute(
            {
              commandType: "RecordDecision",
              commandId: cmd("0000000000f4"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: decisionPayload(humanProposal.proposalId, "Approve"),
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanDecision.ok).toBe(true);
        if (humanDecision.ok) {
          expect(humanDecision.value.events).toHaveLength(2);
          // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
          const fact = humanDecision.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toEqual({
            actor: humanActor,
            targetWorkspaceId: p7RootWorkspace,
            summaryRef:
              "formation proposal fpr_00000000-0000-7000-8000-0000000000f1 approved at revision 1",
            occurredAt: "t",
            kind: "GovernanceDecision",
          });
          expect(fact.causedByCommandId).toBe(cmd("0000000000f4"));
        }
        const agentDecision = yield* tx.transact(
          recordDecision.execute(
            {
              commandType: "RecordDecision",
              commandId: cmd("0000000000f5"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: decisionPayload(agentProposal.proposalId, "Reject"),
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agentDecision.ok).toBe(true);
        if (agentDecision.ok) {
          expect(
            agentDecision.value.events.filter(
              (event) => event.eventType === "HumanInterventionApplied",
            ),
          ).toHaveLength(0);
        }

        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId,
              workId: work,
              targetWorkRevision: parse(WorkRevision)(2),
              missionSnapshot: mission,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* tx.transact(
          verifications.concludeIfOpen(
            verificationId,
            "Pass",
            "summary:test",
            undefined,
          ),
        );
        const acceptWork = makeAcceptWorkOutcomeHandler({
          works,
          verifications,
          acceptances,
        });
        const acceptPayload: AcceptWorkOutcomePayload = {
          acceptanceId: "acc_00000000-0000-7000-8000-0000000000f1" as never,
          workId: work,
          targetWorkRevision: parse(WorkRevision)(2),
          verificationId,
        };
        const humanAccept = yield* tx.transact(
          acceptWork.execute(
            {
              commandType: "AcceptWorkOutcome",
              commandId: cmd("0000000000f6"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: acceptPayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanAccept.ok).toBe(true);
        if (humanAccept.ok) {
          // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
          const fact = humanAccept.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toEqual({
            actor: humanActor,
            targetWorkspaceId: p7RootWorkspace,
            summaryRef: `work outcome accepted: ${work} at revision 2`,
            occurredAt: "t",
            kind: "GovernanceDecision",
          });
        }

        const seedDependency = (dependencyId: string) =>
          sql.unsafe(
            "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
              dependencyId,
              p7Project,
              work,
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
        yield* seedDependency("dep_00000000-0000-7000-8000-000000000fa1");
        yield* seedDependency("dep_00000000-0000-7000-8000-000000000fa2");
        yield* seedDependency("dep_00000000-0000-7000-8000-000000000fa3");
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
              commandId: cmd("0000000000f7"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_00000000-0000-7000-8000-000000000fa1",
                targetDependencyRevision: 0,
                reason: "no longer needed",
              } as WithdrawDependencyPayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanWithdraw.ok).toBe(true);
        if (humanWithdraw.ok) {
          // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
          const fact = humanWithdraw.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toMatchObject({
            targetWorkspaceId: p7RootWorkspace,
            kind: "GovernanceDecision",
            summaryRef:
              "dependency dep_00000000-0000-7000-8000-000000000fa1 withdrawn: no longer needed",
          });
        }
        const humanMark = yield* tx.transact(
          mark.execute(
            {
              commandType: "MarkDependencyUnfulfillable",
              commandId: cmd("0000000000f8"),
              projectId: p7Project,
              actor: humanActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_00000000-0000-7000-8000-000000000fa2",
                targetDependencyRevision: 0,
                justification: "confirmed unfulfillable",
              } as MarkDependencyUnfulfillablePayload,
            },
            { _tag: "External", principal: humanPrincipal },
          ),
        );
        expect(humanMark.ok).toBe(true);
        if (humanMark.ok) {
          // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
          const fact = humanMark.value.events.find(
            (event) => event.eventType === "HumanInterventionApplied",
          )!;
          expect(fact.payload).toMatchObject({
            targetWorkspaceId: p7RootWorkspace,
            kind: "GovernanceDecision",
          });
        }
        const agentWithdraw = yield* tx.transact(
          withdraw.execute(
            {
              commandType: "WithdrawDependency",
              commandId: cmd("0000000000f9"),
              projectId: p7Project,
              actor: agentActor,
              issuedAt: "t",
              payload: {
                dependencyId: "dep_00000000-0000-7000-8000-000000000fa3",
                targetDependencyRevision: 0,
                reason: "agent path",
              } as WithdrawDependencyPayload,
            },
            { _tag: "External", principal: agentPrincipal },
          ),
        );
        expect(agentWithdraw.ok).toBe(true);
        if (agentWithdraw.ok) {
          expect(
            agentWithdraw.value.events.filter(
              (event) => event.eventType === "HumanInterventionApplied",
            ),
          ).toHaveLength(0);
        }

        expect(HUMAN_STOP_EMISSION_PRECONDITION).toBe(
          "resolver-admitted (P12, GQ4)",
        );
        const stopFact = humanStopInterventionEvent({
          projectId: p7Project,
          commandId: cmd("0000000000fa"),
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "stop reason",
          occurredAt: "t",
        });
        expect(stopFact.eventType).toBe("HumanInterventionApplied");
        expect(stopFact.payload).toEqual({
          actor: humanActor,
          targetWorkspaceId: p7RootWorkspace,
          summaryRef: "stop reason",
          occurredAt: "t",
          kind: "Stop",
        });
        const allInterventions = yield* journalEvents(
          "HumanInterventionApplied",
        );
        expect(
          allInterventions.filter((event) => event.payload.kind === "Stop"),
        ).toHaveLength(0);
      }),
      makeP7App(),
    );
  });
});
