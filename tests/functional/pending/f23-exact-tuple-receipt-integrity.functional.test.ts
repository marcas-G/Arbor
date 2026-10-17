import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, type Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assignWorkHandler } from "../../../apps/single-workspace/src/control-actions.js";
import { buildSingleWorkspaceLayer } from "../../../apps/single-workspace/src/index.js";
import type { AgentActionHandlerInput } from "../../../packages/agent-runtime/src/index.js";
import {
  CommandGateway,
  CommandHandlerRegistry,
  newUuid7,
  semanticRequestFingerprint,
} from "../../../packages/application/src/index.js";
import {
  CommandId,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  WorkId,
} from "../../../packages/domain/src/index.js";
import {
  Clock,
  CommandStore,
  RecoveryAttentionFactStore,
  type StoredCommandResolution,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
} from "../../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
} from "../../support/p7-app.js";
import { createSchema45TestDatabaseFactory } from "../../support/schema44-database.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const schemaDatabases: Array<{ cleanup: () => void }> = [];
let schemaDatabaseFactory:
  | Awaited<ReturnType<typeof createSchema45TestDatabaseFactory>>
  | undefined;

const body = (value: unknown) => JSON.stringify(value);

const publicSubmitHumanMessage = (
  baseUrl: string,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
) =>
  fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local",
    },
    body: body({
      commandType: "SubmitHumanMessage",
      commandId: input.commandId,
      projectId: input.projectId,
      actor: input.actor,
      issuedAt: new Date().toISOString(),
      payload: input.payload,
    }),
  });

const snapshot = (db: DatabaseSync, commandId: string) => ({
  receipt: db
    .prepare(
      `SELECT command_id, project_id, semantic_request_fingerprint,
              schema_version, fingerprint_algorithm_version, resolution,
              result_json, terminal_error_json, created_at, settled_at
         FROM commands WHERE command_id = ?`,
    )
    .get(commandId),
  attempts: db
    .prepare(
      "SELECT command_id, attempt_no, outcome, failure_kind FROM command_attempts WHERE command_id = ? ORDER BY attempt_no",
    )
    .all(commandId),
  events: db
    .prepare(
      "SELECT event_id, event_type, aggregate_ref FROM domain_events WHERE caused_by_command_id = ? ORDER BY event_id",
    )
    .all(commandId),
});

const seedRawReceipt = (
  db: DatabaseSync,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly payload: unknown;
    readonly resolution: "Committed" | "TerminalRejected";
    readonly resultJson: string | null;
    readonly terminalErrorJson: string | null;
  },
) => {
  const fingerprint = semanticRequestFingerprint({
    commandType: "SubmitHumanMessage",
    projectId: input.projectId,
    actor: input.actor,
    schemaVersion: "1",
    payload: input.payload,
  });
  db.prepare(
    `INSERT INTO commands (
       command_id, project_id, semantic_request_fingerprint, schema_version,
       fingerprint_algorithm_version, resolution, result_json,
       terminal_error_json, created_at, settled_at
     ) VALUES (?, ?, ?, '1', 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.commandId,
    input.projectId,
    fingerprint,
    input.resolution,
    input.resultJson,
    input.terminalErrorJson,
    "2026-10-10T00:00:00.000Z",
    "2026-10-10T00:00:00.000Z",
  );
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const database of schemaDatabases.splice(0)) database.cleanup();
});

beforeAll(async () => {
  schemaDatabaseFactory = await createSchema45TestDatabaseFactory({
    prefix: ".f23-exact-tuple-schema45-",
  });
}, 120_000);

afterAll(() => schemaDatabaseFactory?.cleanup());

const createSchemaDatabase = () => {
  if (schemaDatabaseFactory === undefined) {
    throw new Error("Schema-44 database factory is unavailable.");
  }
  const database = schemaDatabaseFactory.create();
  schemaDatabases.push(database);
  return database;
};

describe("pending F23 exact-tuple receipt integrity", () => {
  it("rejects a valid-JSON wrong-shape exact Committed result without mutation", async () => {
    const sentinel = `F23-RESULT-SHAPE-${crypto.randomUUID()}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: () => ({ _tag: "HttpError", status: 500 }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 exact result decoder",
    );
    const commandId = functionalId("cmd");
    const payload = {
      messageId: functionalId("msg"),
      targetWorkspaceId: project.rootWorkspaceId,
      bodyRef: "body-ref-exact-shape",
    };
    const db = new DatabaseSync(fixture.databaseFile);
    try {
      seedRawReceipt(db, {
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        payload,
        resolution: "Committed",
        resultJson: JSON.stringify({ unexpected: sentinel }),
        terminalErrorJson: null,
      });
      const before = snapshot(db, commandId);

      const response = await publicSubmitHumanMessage(fixture.baseUrl, {
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        payload,
      });
      const text = await response.text();
      const decoded = JSON.parse(text) as {
        readonly problem?: {
          readonly code?: string;
          readonly category?: string;
          readonly retryDisposition?: string;
        };
      };

      expect(response.status).toBe(503);
      expect(decoded.problem).toMatchObject({
        code: "persistence/corruption",
        category: "unavailable",
        retryDisposition: "non-retryable",
      });
      expect(text).not.toContain(sentinel);
      expect(snapshot(db, commandId)).toEqual(before);
      expect(fixture.daemonErrors).toEqual([]);
    } finally {
      db.close();
    }
  }, 45_000);

  it("does not return a wrong-shape exact TerminalRejected as a semantic rejection", async () => {
    const sentinel = `F23-REJECTION-SHAPE-${crypto.randomUUID()}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: () => ({ _tag: "HttpError", status: 500 }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 exact rejection decoder",
    );
    const commandId = functionalId("cmd");
    const payload = {
      messageId: functionalId("msg"),
      targetWorkspaceId: project.rootWorkspaceId,
      bodyRef: "body-ref-exact-rejection",
    };
    const db = new DatabaseSync(fixture.databaseFile);
    try {
      seedRawReceipt(db, {
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        payload,
        resolution: "TerminalRejected",
        resultJson: null,
        terminalErrorJson: JSON.stringify({
          _tag: "AuthorityDenied",
          unowned: sentinel,
        }),
      });
      const before = snapshot(db, commandId);

      const response = await publicSubmitHumanMessage(fixture.baseUrl, {
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        payload,
      });
      const text = await response.text();
      const decoded = JSON.parse(text) as {
        readonly problem?: {
          readonly code?: string;
          readonly category?: string;
          readonly retryDisposition?: string;
        };
      };

      expect(response.status).toBe(503);
      expect(decoded.problem).toMatchObject({
        code: "persistence/corruption",
        category: "unavailable",
        retryDisposition: "non-retryable",
      });
      expect(text).not.toContain(sentinel);
      expect(snapshot(db, commandId)).toEqual(before);
      expect(fixture.daemonErrors).toEqual([]);
    } finally {
      db.close();
    }
  }, 45_000);

  it("does not treat an incomplete AH10 prior AssignWork receipt as successful replay", async () => {
    const database = createSchemaDatabase();
    const app = buildSingleWorkspaceLayer({
      databaseFile: database.databaseFilename,
      blobRoot: `${database.directory}/blobs`,
    });
    const providerTurnId = parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789af",
    );
    const outputPosition = 2;
    const occurrence = `${providerTurnId}:${outputPosition}`;
    const priorCommandId = parse(CommandId)(
      `cmd_${newUuid7("assign-work-command", occurrence)}`,
    );
    const resultWorkId = parse(WorkId)(
      `wrk_${newUuid7("assign-work", occurrence)}`,
    );
    const executionId = parse(ExecutionId)(
      "exe_018f2b3c-4d5e-7abc-8def-0123456789af",
    );
    const actionInput = {
      action: {
        _tag: "AssignWork",
        objective: "one bounded assigned Work",
        why: "test recovery identity",
        constraints: ["stay in the current workspace"],
        completionExpectation: "the assigned Work exists",
        verificationMission: {
          goal: "verify the assigned Work",
          criteria: [],
          riskRequirements: [],
        },
        reason: "pending receipt integrity qualification",
      },
      invocation: {
        providerTurnId,
        outputPosition,
        callRef: "call-f23-ah10-prior",
        toolName: "assign_work",
        argumentsJson: "{}",
      },
      execution: {
        executionId,
        projectId: p7Project,
        workspaceId: p7RootWorkspace,
        sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
        binding: {
          _tag: "WorkspaceExecution",
          workspaceId: p7RootWorkspace,
          episode: {
            _tag: "WorkEpisode",
            workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789ae",
            targetWorkRevision: 0,
          },
        },
        admittedAt: "2026-10-10T00:00:00.000Z",
        stopRequestedAt: null,
        state: { status: "Active", settlement: null },
      },
      context: {
        _tag: "ExecutionOrigin",
        principal: "agent:f23-receipt-integrity",
        executionId,
        fencingGeneration: 1,
      },
      logicalActionId: "act_018f2b3c-4d5e-7abc-8def-0123456789af",
    } as unknown as AgentActionHandlerInput;

    const program = Effect.gen(function* () {
      yield* p7SeedProject;
      const sql = yield* SqlClient;
      const tx = yield* TransactionPort;
      const commandReceipts = yield* CommandStore;
      const workspaces = yield* WorkspaceRepository;
      const gateway = yield* CommandGateway;
      const commandHandlerRegistry = yield* CommandHandlerRegistry;
      const clock = yield* Clock;
      const mismatchFingerprint = semanticRequestFingerprint({
        commandType: "AssignWork",
        projectId: p7Project,
        actor: "agent:f23-receipt-integrity",
        schemaVersion: "1",
        payload: { unrelated: true },
      });
      yield* tx.transact(
        sql.unsafe(
          `INSERT INTO commands (
             command_id, project_id, semantic_request_fingerprint,
             schema_version, fingerprint_algorithm_version, resolution,
             result_json, terminal_error_json, created_at, settled_at
           ) VALUES (?, ?, ?, '1', 1, 'Committed', ?, NULL, ?, ?)`,
          [
            priorCommandId,
            p7Project,
            mismatchFingerprint,
            JSON.stringify({
              workId: resultWorkId,
              workspaceId: p7RootWorkspace,
              unexpected: "schema-v1-missing-lifecycle-and-revision",
            }),
            "2026-10-10T00:00:00.000Z",
            "2026-10-10T00:00:00.000Z",
          ],
        ),
      );
      const handler = assignWorkHandler({
        gateway,
        commandHandlerRegistry,
        commandReceipts,
        workspaces,
        clock,
        tx,
      });
      return yield* Effect.exit(handler.handle(actionInput));
    });

    const exit = await Effect.runPromise(
      Effect.provide(
        program,
        app as Layer.Layer<
          | CommandGateway
          | CommandHandlerRegistry
          | SqlClient
          | CommandStore
          | TransactionPort
          | WorkspaceRepository
          | Clock
        >,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("AgentActionOperationalFailure");
      }
    }
  }, 45_000);

  it.each([
    "syntax-corrupt",
    "parseable-wrong-shape",
    "unknown-stored-version",
    "command-id-mismatch",
    "project-mismatch",
  ] as const)(
    "applies the established P9 disposition to %s direct-child prior receipt",
    async (corruptionKind) => {
      const providerTurnId = parse(ProviderTurnId)(
        "ptn_018f2b3c-4d5e-7abc-8def-0123456789b0",
      );
      const outputPosition = 1;
      const occurrence = `${providerTurnId}:${outputPosition}`;
      const priorCommandId = parse(CommandId)(
        `cmd_${newUuid7("assign-work-command", occurrence)}`,
      );
      const executionId = parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789b0",
      );
      const logicalActionId = "act_018f2b3c-4d5e-7abc-8def-0123456789b0";
      const leakSentinel = `F23-P9-A1-${crypto.randomUUID()}`;
      const rawMalformedResult =
        corruptionKind === "syntax-corrupt"
          ? `{"leak_marker_${leakSentinel}":`
          : JSON.stringify({ leak_marker: leakSentinel });
      const stored = {
        commandId:
          corruptionKind === "command-id-mismatch"
            ? parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ae")
            : priorCommandId,
        projectId:
          corruptionKind === "project-mismatch"
            ? parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ae")
            : p7Project,
        semanticRequestFingerprint: "f".repeat(64),
        schemaVersion: corruptionKind === "unknown-stored-version" ? "99" : "1",
        fingerprintAlgorithmVersion: 1,
        resolution: "Committed",
        resultJson: rawMalformedResult,
        terminalErrorJson: null,
        createdAt: "2026-10-10T00:00:00.000Z",
        settledAt: "2026-10-10T00:00:00.000Z",
      } as StoredCommandResolution;
      const storedBefore = structuredClone(stored);
      const p9Facts: Array<Record<string, unknown>> = [];
      let gatewayCalls = 0;
      const tx = {
        transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
          Effect.provideService(body, TransactionScope, {
            session: { id: "f23-p9-disposition" },
          }),
      } as never;
      const handler = assignWorkHandler({
        gateway: {
          execute: () => {
            gatewayCalls += 1;
            return Effect.succeed({} as never);
          },
        } as never,
        commandReceipts: {
          findResolution: () => Effect.succeed(Option.some(stored)),
        } as never,
        workspaces: {
          findById: () => Effect.succeed(Option.none()),
        } as never,
        clock: {
          now: () => Effect.succeed("2026-10-10T00:00:00.000Z"),
        } as never,
        tx,
        commandHandlerRegistry: {
          lookup: (commandType: string) =>
            commandType === "AssignWork"
              ? Option.some({ commandType, schemaVersion: "1" } as never)
              : Option.none(),
        } as never,
        bindings: {
          findByExecutionAndAction: () => Effect.succeed([]),
          findByCommandId: () => Effect.succeed(Option.none()),
        } as never,
        works: { findById: () => Effect.succeed(Option.none()) } as never,
        grants: { findById: () => Effect.succeed(Option.none()) } as never,
        approvals: { findById: () => Effect.succeed(Option.none()) } as never,
        journal: {} as never,
        bindingAttention: {
          recordAssignWorkBindingFailure: (input: Record<string, unknown>) =>
            Effect.sync(() => {
              p9Facts.push(input);
            }),
        } as never,
      });
      const actionInput = {
        action: {
          _tag: "AssignWork",
          targetWorkspaceRef: "child:opaque-target",
          objective: "one child Work",
          why: "recover the exact committed action",
          constraints: [],
          completionExpectation: "the Work is assigned",
          verificationMission: {
            goal: "verify assignment",
            criteria: [],
            riskRequirements: [],
          },
          reason: "pending P9 receipt disposition qualification",
        },
        invocation: {
          providerTurnId,
          outputPosition,
          callRef: "call-f23-p9-syntax-corrupt",
          toolName: "assign_work",
          argumentsJson: "{}",
        },
        execution: {
          executionId,
          projectId: p7Project,
          workspaceId: p7RootWorkspace,
          sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789b0",
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId: p7RootWorkspace,
            episode: {
              _tag: "WorkEpisode",
              workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789b0",
              targetWorkRevision: 0,
            },
          },
          admittedAt: "2026-10-10T00:00:00.000Z",
          stopRequestedAt: null,
          state: { status: "Active", settlement: null },
        },
        context: {
          _tag: "ExecutionOrigin",
          principal: "agent:f23-p9-disposition",
          executionId,
          fencingGeneration: 1,
        },
        logicalActionId,
        assignWorkReplay: true,
      } as unknown as AgentActionHandlerInput;

      const exit = await Effect.runPromiseExit(handler.handle(actionInput));
      expect(structuredClone(stored)).toEqual(storedBefore);

      const proofCorruption =
        corruptionKind === "syntax-corrupt" ||
        corruptionKind === "parseable-wrong-shape" ||
        corruptionKind === "unknown-stored-version";
      expect(p9Facts).toHaveLength(proofCorruption ? 1 : 0);
      if (proofCorruption) {
        expect(p9Facts[0]).toMatchObject({
          committedCommandId: priorCommandId,
          executionId,
          logicalActionId,
          failureCode: "ReceiptMismatch",
        });
      }
      expect(JSON.stringify(p9Facts)).not.toContain(leakSentinel);
      expect(gatewayCalls).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe(
            proofCorruption
              ? "AgentActionRecoveryBlocked"
              : "AgentActionOperationalFailure",
          );
        }
      }
    },
  );

  it("rolls back the P9 fact/event and fails closed when the real fact insert fails", async () => {
    const database = createSchemaDatabase();
    const app = buildSingleWorkspaceLayer({
      databaseFile: database.databaseFilename,
      blobRoot: `${database.directory}/blobs`,
    });
    const providerTurnId = parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const occurrence = `${providerTurnId}:1`;
    const priorCommandId = parse(CommandId)(
      `cmd_${newUuid7("assign-work-command", occurrence)}`,
    );
    const executionId = parse(ExecutionId)(
      "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const logicalActionId = "act_018f2b3c-4d5e-7abc-8def-0123456789b1";
    const rawMalformedResult = '{"p9_transaction_marker":';
    const actionInput = {
      action: {
        _tag: "AssignWork",
        targetWorkspaceRef: "child:opaque-target",
        objective: "one child Work",
        why: "recover the exact committed action",
        constraints: [],
        completionExpectation: "the Work is assigned",
        verificationMission: {
          goal: "verify assignment",
          criteria: [],
          riskRequirements: [],
        },
        reason: "pending P9 fact transaction qualification",
      },
      invocation: {
        providerTurnId,
        outputPosition: 1,
        callRef: "call-f23-p9-fact-rollback",
        toolName: "assign_work",
        argumentsJson: "{}",
      },
      execution: {
        executionId,
        projectId: p7Project,
        workspaceId: p7RootWorkspace,
        sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c2",
        binding: {
          _tag: "WorkspaceExecution",
          workspaceId: p7RootWorkspace,
          episode: {
            _tag: "WorkEpisode",
            workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789b1",
            targetWorkRevision: 0,
          },
        },
        admittedAt: "2026-10-10T00:00:00.000Z",
        stopRequestedAt: null,
        state: { status: "Active", settlement: null },
      },
      context: {
        _tag: "ExecutionOrigin",
        principal: "agent:f23-p9-fact-rollback",
        executionId,
        fencingGeneration: 1,
      },
      logicalActionId,
      assignWorkReplay: true,
    } as unknown as AgentActionHandlerInput;
    let gatewayCalls = 0;

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* p7SeedProject;
          const sql = yield* SqlClient;
          const tx = yield* TransactionPort;
          const commandReceipts = yield* CommandStore;
          const commandHandlerRegistry = yield* CommandHandlerRegistry;
          const bindingAttention = yield* RecoveryAttentionFactStore;
          const workspaces = yield* WorkspaceRepository;
          const clock = yield* Clock;
          yield* tx.transact(
            sql.unsafe(
              `INSERT INTO commands (
                 command_id, project_id, semantic_request_fingerprint,
                 schema_version, fingerprint_algorithm_version, resolution,
                 result_json, terminal_error_json, created_at, settled_at
               ) VALUES (?, ?, ?, '1', 1, 'Committed', ?, NULL, ?, ?)`,
              [
                priorCommandId,
                p7Project,
                "a".repeat(64),
                rawMalformedResult,
                "2026-10-10T00:00:00.000Z",
                "2026-10-10T00:00:00.000Z",
              ],
            ),
          );
          yield* tx.transact(
            sql.unsafe(
              `CREATE TRIGGER fail_p9_attention_fact_insert
               BEFORE INSERT ON assign_work_binding_attention_facts
               BEGIN SELECT RAISE(ABORT, 'injected P9 fact write failure'); END`,
            ),
          );
          const handler = assignWorkHandler({
            gateway: {
              execute: () => {
                gatewayCalls += 1;
                return Effect.succeed({} as never);
              },
            } as never,
            commandHandlerRegistry,
            commandReceipts,
            workspaces,
            clock,
            tx,
            bindingAttention,
          });
          const exit = yield* Effect.exit(handler.handle(actionInput));
          const receipt = yield* sql.unsafe<{ result_json: string }>(
            "SELECT result_json FROM commands WHERE command_id = ?",
            [priorCommandId],
          );
          const facts = yield* sql.unsafe<{ attention_fact_id: string }>(
            "SELECT attention_fact_id FROM assign_work_binding_attention_facts",
          );
          const events = yield* sql.unsafe<{ event_id: string }>(
            "SELECT event_id FROM domain_events WHERE event_type = 'AssignWorkTargetBindingEscalated'",
          );
          return { exit, receipt, facts, events };
        }),
        app as Layer.Layer<
          | SqlClient
          | TransactionPort
          | CommandGateway
          | CommandStore
          | CommandHandlerRegistry
          | RecoveryAttentionFactStore
          | WorkspaceRepository
          | Clock
        >,
      ),
    );

    expect(result.receipt).toEqual([{ result_json: rawMalformedResult }]);
    expect(result.facts).toEqual([]);
    expect(result.events).toEqual([]);
    expect(gatewayCalls).toBe(0);
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(JSON.stringify(result.exit)).not.toContain("p9_transaction_marker");
    if (Exit.isFailure(result.exit)) {
      const failure = Cause.findErrorOption(result.exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("AgentActionOperationalFailure");
      }
    }
  });
});
