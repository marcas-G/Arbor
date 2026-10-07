import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGateway, semanticRequestFingerprint } from "@arbor/application";
import {
  Actor,
  CommandId,
  DependencyId,
  DependencyRevision,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  type CommandStoreService,
  DeliverableRepository,
  DomainEventJournal,
  IdGenerator,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  deliverHandler,
  produceDeliverableHandler,
} from "../src/control-actions.js";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  ProductionDaemonService,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-012345678a31");
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345678a31",
);
const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345678a32",
);
const consumerWorkId = parse(WorkId)(
  "wrk_018f2b3c-4d5e-7abc-8def-012345678a31",
);
const producerWorkId = parse(WorkId)(
  "wrk_018f2b3c-4d5e-7abc-8def-012345678a32",
);
const childSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-012345678a32",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-012345678a32",
);
const principal = parse(Principal)("runtime:producer-agent");
const actor = parse(Actor)("runtime:producer-agent");
const directories: string[] = [];

describe("MAC-P3 cross-Work deliverable closure", () => {
  it("declares, produces, delivers, deterministically satisfies and wakes without a model satisfy action", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p3-delivery-"));
    directories.push(directory);
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(directory, "slice.db"),
      projectId,
      providerTurns: [],
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,'{}',0,'{}','local','Open',0,'t','t')",
                [projectId, "delivery", parentWorkspaceId],
              );
              for (const [session, workspace] of [
                ["ses_018f2b3c-4d5e-7abc-8def-012345678a31", parentWorkspaceId],
                [childSessionId, childWorkspaceId],
              ]) {
                yield* sql.unsafe(
                  "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
                  [session, workspace],
                );
              }
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'parent','{}',0,'{}',0,'{}','ses_018f2b3c-4d5e-7abc-8def-012345678a31',?,'{}',0,0,'Active','t','t')",
                [parentWorkspaceId, projectId, consumerWorkId],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,'child','{}',0,'{}',0,'{}',?,?,'{}',0,0,'Active','t','t')",
                [
                  childWorkspaceId,
                  projectId,
                  parentWorkspaceId,
                  childSessionId,
                  producerWorkId,
                ],
              );
              for (const [work, workspace, objective] of [
                [consumerWorkId, parentWorkspaceId, "consume report"],
                [producerWorkId, childWorkspaceId, "produce report"],
              ]) {
                yield* sql.unsafe(
                  "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,'cross-work','[]','done','{}','{}','Open',0,'t','t')",
                  [work, projectId, workspace, objective],
                );
              }
            }),
          );
          const gateway = yield* CommandGateway;
          const dependencyId = parse(DependencyId)(
            "dep_018f2b3c-4d5e-7abc-8def-012345678a31",
          );
          const declarePayload = {
            dependencyId,
            consumerWorkId,
            producerBinding: {
              _tag: "WorkspaceBound" as const,
              workspaceId: childWorkspaceId,
            },
            expectedDeliverable: {
              kind: "research-report" as never,
              requiredArtifactRoles: [],
            },
            expectedConsumerWorkRevision: parse(WorkRevision)(0),
            revision: parse(DependencyRevision)(0),
          };
          const declareCommandId = parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-012345678a31",
          );
          const declared = yield* gateway.execute(
            {
              commandType: "DeclareDependency",
              commandId: declareCommandId,
              projectId,
              actor,
              issuedAt: "2026-10-04T00:00:00.000Z",
              payload: declarePayload,
            },
            { _tag: "System", principal, causationRef: "mac-p3" },
            {
              _tag: "DeclareDependencyAuthority",
              principal,
              commandId: declareCommandId,
              semanticRequestFingerprint: semanticRequestFingerprint({
                commandType: "DeclareDependency",
                projectId,
                actor,
                schemaVersion: "1",
                payload: declarePayload,
              }),
              projectId,
              targetWorkspaceId: parentWorkspaceId,
              consumerWorkId,
            },
          );
          const execution = {
            executionId,
            projectId,
            workspaceId: childWorkspaceId,
            binding: {
              _tag: "WorkspaceExecution" as const,
              workspaceId: childWorkspaceId,
              episode: {
                _tag: "WorkEpisode" as const,
                workId: producerWorkId,
                targetWorkRevision: parse(WorkRevision)(0),
              },
            },
            sessionId: childSessionId,
            admittedAt: "t",
            stopRequestedAt: null,
            state: { status: "Active" as const, settlement: null },
          };
          const context = {
            _tag: "System" as const,
            principal,
            causationRef: "mac-p3-producer",
          };
          const produced = yield* produceDeliverableHandler({
            gateway,
            commandReceipts: {
              findResolution: () => Effect.succeed(Option.none()),
            } as Pick<CommandStoreService, "findResolution">,
            clock: yield* Clock,
            tx: yield* TransactionPort,
          }).handle({
            action: {
              _tag: "ProduceDeliverable",
              kind: "research-report",
              artifacts: [],
            },
            invocation: {
              providerTurnId: "ptn_produce_report" as never,
              outputPosition: 0,
              callRef: "produce-report",
              toolName: "produce_deliverable",
              argumentsJson: "{}",
            },
            execution,
            context,
          });
          if (produced._tag !== "Observation") {
            return yield* Effect.die("produce did not return an observation");
          }
          const deliverableId = /DeliverableProduced\((del_[^,]+)/u.exec(
            produced.observation.text,
          )?.[1];
          if (deliverableId === undefined) {
            return yield* Effect.die(
              "produce observation has no deliverable id",
            );
          }
          const delivered = yield* deliverHandler({
            deliverables: yield* DeliverableRepository,
            works: yield* WorkRepository,
            workspaces: yield* WorkspaceRepository,
            messages: yield* MessageStore,
            inbox: yield* InboxProjectionStore,
            journal: yield* DomainEventJournal,
            clock: yield* Clock,
            tx: yield* TransactionPort,
            ids: yield* IdGenerator,
          }).handle({
            action: {
              _tag: "Deliver",
              deliverableId: deliverableId as never,
              summary: "research report ready",
            },
            invocation: {
              providerTurnId: "ptn_deliver_report" as never,
              outputPosition: 0,
              callRef: "deliver-report",
              toolName: "deliver",
              argumentsJson: "{}",
            },
            execution,
            context,
          });
          const daemon = yield* ProductionDaemonService;
          yield* daemon.daemon.pollConsumers;
          yield* daemon.daemon.pollConsumers;
          const dependencies = yield* sql.unsafe<{
            state: string;
            satisfied_by_deliverable_id: string | null;
          }>(
            "SELECT state, satisfied_by_deliverable_id FROM dependencies WHERE dependency_id = ?",
            [dependencyId],
          );
          const messages = yield* sql.unsafe<{
            kind: string;
            recipient_workspace_id: string;
          }>("SELECT kind, recipient_workspace_id FROM messages");
          const inbox = yield* sql.unsafe<{ kind: string; summary: string }>(
            "SELECT kind, summary FROM inbox_entries WHERE workspace_id = ?",
            [parentWorkspaceId],
          );
          const producerInbox = yield* sql.unsafe<{
            entry_key: string;
            kind: string;
          }>(
            "SELECT entry_key, kind FROM inbox_entries WHERE workspace_id = ? AND entry_key LIKE 'dep-request:%'",
            [childWorkspaceId],
          );
          const offsets = yield* sql.unsafe<{
            consumer_id: string;
            last_sequence: number;
          }>("SELECT consumer_id, last_sequence FROM consumer_offsets");
          const deadLetters = yield* sql.unsafe<{
            consumer_id: string;
            reason: string;
          }>("SELECT consumer_id, reason FROM consumer_dead_letters");
          const events = yield* sql.unsafe<{ event_type: string }>(
            "SELECT event_type FROM domain_events ORDER BY sequence",
          );
          return {
            declared: declared.resolution._tag,
            produced,
            delivered,
            deliverableId,
            dependencies,
            messages,
            inbox,
            producerInbox,
            offsets,
            deadLetters,
            events,
          };
        }),
        app,
      ),
    );
    expect(result.declared).toBe("Committed");
    expect(result.produced._tag).toBe("Observation");
    expect(result.delivered._tag).toBe("Observation");
    expect(result.dependencies, JSON.stringify(result)).toEqual([
      {
        state: "Satisfied",
        satisfied_by_deliverable_id: result.deliverableId,
      },
    ]);
    expect(result.messages).toEqual([
      { kind: "Deliver", recipient_workspace_id: parentWorkspaceId },
    ]);
    expect(result.inbox).toEqual([
      expect.objectContaining({
        kind: "Message",
        summary: expect.stringContaining(result.deliverableId),
      }),
    ]);
    expect(result.producerInbox).toEqual([
      {
        entry_key: `dep-request:dep_018f2b3c-4d5e-7abc-8def-012345678a31:0`,
        kind: "Message",
      },
    ]);
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
