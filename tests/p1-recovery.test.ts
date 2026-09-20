import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  OwnershipWriteServiceLive,
  P1_MIGRATIONS,
  ProjectionStoreLive,
  ResourceOwnershipRepositoryLive,
  runConsumerBatch,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { CommandGateway } from "../packages/application/src/index.js";
import {
  CommandId,
  type EventTypeName,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type Clock,
  ConsumerOffsetStore,
  DomainEventJournal,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  countRows,
  faultingTransaction,
  makeP1App,
  runP1,
  seedProject,
  testActor,
} from "./support/p1-app.js";

const projectA = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789d1");
const projectFault = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const rootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const faultWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const rootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const faultSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const seedCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);

const attemptRows = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ outcome: string }>(
      "SELECT outcome FROM command_attempts WHERE command_id = ? ORDER BY attempt_no",
      [commandId],
    );
    return rows.map((row) => row.outcome);
  });

describe("P1-014 recovery matrix — command transaction", () => {
  it("C3/C4/C8 rollback-after-body leaves no partial state", async () => {
    const app = makeP1App(
      ":memory:",
      faultingTransaction("rollback-after-body", 2),
    );
    const faultCommandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789d2",
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedProject({
        projectId: projectA,
        rootWorkspaceId: rootWorkspace,
        sessionId: rootSession,
        commandId: seedCommandId,
      });
      const failure = yield* seedProject({
        projectId: projectFault,
        rootWorkspaceId: faultWorkspace,
        sessionId: faultSession,
        commandId: faultCommandId,
      }).pipe(Effect.flip);
      return {
        failure,
        projects: yield* countRows("projects"),
        commands: yield* countRows("commands"),
        events: yield* countRows("domain_events"),
        attempts: yield* attemptRows(faultCommandId),
      };
    });
    const result = await runP1(program, app);
    expect((result.failure as { _tag: string })._tag).toBe(
      "TransactionOperationalFailure",
    );
    expect(result.projects).toBe(1);
    expect(result.commands).toBe(1);
    expect(result.events).toBe(2);
    expect(result.attempts).toEqual(["RetryableOperationalFailure"]);
  });

  it("C2/C9 fail-on-begin produces no resolution and records a retryable attempt", async () => {
    const app = makeP1App(":memory:", faultingTransaction("fail-on-begin", 2));
    const faultCommandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789d3",
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedProject({
        projectId: projectA,
        rootWorkspaceId: rootWorkspace,
        sessionId: rootSession,
        commandId: seedCommandId,
      });
      const failure = yield* seedProject({
        projectId: projectFault,
        rootWorkspaceId: faultWorkspace,
        sessionId: faultSession,
        commandId: faultCommandId,
      }).pipe(Effect.flip);
      return {
        failure,
        commands: yield* countRows("commands"),
        attempts: yield* attemptRows(faultCommandId),
      };
    });
    const result = await runP1(program, app);
    expect((result.failure as { _tag: string })._tag).toBe(
      "TransactionOperationalFailure",
    );
    expect(result.commands).toBe(1);
    expect(result.attempts).toEqual(["RetryableOperationalFailure"]);
  });

  it("C5/C10/C11 durability is asserted via synchronous=FULL and WAL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-recovery-"));
    const app = makeP1App(join(dir, "recovery.db"));
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const sql = yield* SqlClient;
      const synchronous = yield* sql.unsafe<{ synchronous: number }>(
        "PRAGMA synchronous",
      );
      const journal = yield* sql.unsafe<{ journal_mode: string }>(
        "PRAGMA journal_mode",
      );
      return {
        synchronous: Number(synchronous[0]?.synchronous),
        journal: journal[0]?.journal_mode,
      };
    });
    const result = await runP1(program, app);
    expect(result.synchronous).toBe(2);
    expect(result.journal?.toLowerCase()).toBe("wal");
  });

  it("C6/C7 post-commit replay yields one authoritative resolution", async () => {
    const app = makeP1App();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789d4",
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const first = yield* seedProject({
        projectId: projectA,
        rootWorkspaceId: rootWorkspace,
        sessionId: rootSession,
        commandId,
      });
      const replay = yield* seedProject({
        projectId: projectA,
        rootWorkspaceId: rootWorkspace,
        sessionId: rootSession,
        commandId,
      });
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
        [commandId],
      );
      return { first, replay, count: Number(rows[0]?.count ?? 0) };
    });
    const result = await runP1(program, app);
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.replay.resolution._tag).toBe("Committed");
    expect(result.count).toBe(1);
  });
});

describe("P1-014 recovery matrix — consumer / projection", () => {
  const consumerId = "recovery-consumer";

  const makeConsumerApp = (
    projection: Layer.Layer<ProjectionStore, unknown, SqlClient | Clock>,
  ) => {
    const base = layer({ filename: ":memory:" });
    const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
    const deps = Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(DomainEventJournalLive, infra),
      Layer.provide(ConsumerOffsetStoreLive, infra),
      Layer.provide(ConsumerDeadLetterStoreLive, infra),
      Layer.provide(projection, infra),
    );
    return Layer.mergeAll(infra, deps);
  };

  const draft = (name: string, eventVersion: number) => ({
    projectId: projectA,
    eventType: name as EventTypeName,
    eventVersion,
    occurredAt: "t",
    aggregateRef: projectA,
    actor: testActor,
    payload: {},
  });

  it("P1/P2 apply-then-advance and idempotent re-delivery", async () => {
    const app = makeConsumerApp(ProjectionStoreLive);
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const tx = yield* TransactionPort;
      const journal = yield* DomainEventJournal;
      const offsets = yield* ConsumerOffsetStore;
      yield* tx.transact(journal.append([draft("ProjectCreated", 1)]));
      const first = yield* runConsumerBatch(consumerId, projectA, 10);
      const second = yield* runConsumerBatch(consumerId, projectA, 10);
      const offset = yield* tx.transact(offsets.read(consumerId, projectA));
      return { first, second, offset };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.first.applied).toBe(1);
    expect(result.second.applied).toBe(0);
    expect(result.offset).toBe(1);
  });

  it("P3 transient projection error does not advance the offset", async () => {
    const failingProjection = Layer.succeed(ProjectionStore, {
      apply: () =>
        Effect.fail({
          _tag: "ConsumerOffsetStoreFailure" as const,
          cause: "injected projection error",
        }),
      reset: () => Effect.void,
    });
    const app = makeConsumerApp(failingProjection);
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const tx = yield* TransactionPort;
      const journal = yield* DomainEventJournal;
      const offsets = yield* ConsumerOffsetStore;
      yield* tx.transact(journal.append([draft("ProjectCreated", 1)]));
      const failed = yield* runConsumerBatch(consumerId, projectA, 10).pipe(
        Effect.flip,
      );
      const offset = yield* tx.transact(offsets.read(consumerId, projectA));
      return { failed, offset };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect((result.failed as { _tag: string })._tag).toBe(
      "ConsumerOffsetStoreFailure",
    );
    expect(result.offset).toBe(0);
  });

  it("P4 poison event is dead-lettered and skipped without stalling", async () => {
    const app = makeConsumerApp(ProjectionStoreLive);
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const tx = yield* TransactionPort;
      const journal = yield* DomainEventJournal;
      const offsets = yield* ConsumerOffsetStore;
      yield* tx.transact(
        journal.append([
          draft("ProjectCreated", 1),
          draft("WorkspaceCreated", 2),
        ]),
      );
      const batch = yield* runConsumerBatch(consumerId, projectA, 10);
      const offset = yield* tx.transact(offsets.read(consumerId, projectA));
      const sql = yield* SqlClient;
      const dead = yield* sql.unsafe<{ sequence: number }>(
        "SELECT sequence FROM consumer_dead_letters WHERE consumer_id = ?",
        [consumerId],
      );
      return { batch, offset, dead: dead.map((row) => row.sequence) };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.batch.applied).toBe(1);
    expect(result.batch.quarantined).toBe(1);
    expect(result.offset).toBe(2);
    expect(result.dead).toEqual([2]);
  });
});

describe("P1-014 recovery matrix — ownership and migration", () => {
  const badWorkspace = parse(WorkspaceId)(
    "ws_018f2b3c-4d5e-7abc-8def-0123456789ef",
  );

  const makeOwnershipApp = () => {
    const base = layer({ filename: ":memory:" });
    const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
    const services = Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ResourceOwnershipRepositoryLive, infra),
      Layer.provide(EnvironmentRevisionStoreLive, infra),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: (_projectId, addresses) =>
          Effect.succeed({
            regions: addresses.map((address) => ({
              resourceSpaceId: "filesystem",
              normalizedRegion: address,
            })),
            observedEnvironmentRevision: "rev",
          }),
      }),
    );
    return Layer.mergeAll(
      infra,
      services,
      Layer.provide(OwnershipWriteServiceLive, services),
    );
  };

  const seedOwnershipRows = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [
            projectA,
            "p",
            rootWorkspace,
            "{}",
            0,
            "{}",
            "local",
            "Open",
            0,
            "t",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
          [rootSession, "WorkspacePrimary", rootWorkspace, 0, "t"],
        );
        yield* sql.unsafe(
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
          [
            rootWorkspace,
            projectA,
            "w",
            "{}",
            0,
            "{}",
            0,
            "{}",
            rootSession,
            "{}",
            0,
            0,
            "Active",
            "t",
            "t",
          ],
        );
      }),
    );
  });

  const claim = (workspaceId: WorkspaceId) => ({
    claimId: "clm_1",
    workspaceId,
    region: {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "FileTree", path: "/repo/a" },
    },
    sourceAddressSnapshot: { _tag: "FileTree" as const, path: "/repo/a" },
    resourceBoundaryRevision: 1,
    resolvedAtEnvironmentRevision: "rev",
    createdAt: "t",
    releasedAt: null,
  });

  it("ownership write rolls back on a constraint failure", async () => {
    const app = makeOwnershipApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedOwnershipRows;
      const ownership = yield* OwnershipWriteService;
      const failed = yield* ownership
        .resolveAndWrite(
          projectA,
          [{ _tag: "FileTree", path: "/repo/a" }],
          [claim(badWorkspace) as never],
        )
        .pipe(Effect.flip);
      return {
        failed,
        claims: yield* countRows("resource_ownership"),
        revisions: yield* countRows("environment_revisions"),
      };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect((result.failed as { _tag: string })._tag).toBe(
      "ResourceOwnershipRepositoryFailure",
    );
    expect(result.claims).toBe(0);
    expect(result.revisions).toBe(0);
  });

  it("ownership write reports ResourceResolutionStale when the revision moved", async () => {
    const app = makeOwnershipApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seedOwnershipRows;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?,?,?)",
        [projectA, "rev-old", "t"],
      );
      const ownership = yield* OwnershipWriteService;
      const failed = yield* ownership
        .resolveAndWrite(
          projectA,
          [{ _tag: "FileTree", path: "/repo/a" }],
          [claim(rootWorkspace) as never],
        )
        .pipe(Effect.flip);
      return { failed, claims: yield* countRows("resource_ownership") };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect((result.failed as { _tag: string })._tag).toBe(
      "ResourceResolutionStale",
    );
    expect(result.claims).toBe(0);
  });

  it("migration failure rolls back and leaves user_version unchanged", async () => {
    const app = layer({ filename: ":memory:" });
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failed = yield* runMigrations([
        {
          id: 1,
          name: "bad",
          sql: "CREATE TABLE ok (id TEXT); INSERT INTO missing VALUES (1)",
        },
      ]).pipe(Effect.flip);
      const versionAfterFailure = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const applied = yield* runMigrations(P1_MIGRATIONS);
      const versionAfterRetry = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      return {
        failed,
        versionAfterFailure: Number(versionAfterFailure[0]?.user_version),
        applied,
        versionAfterRetry: Number(versionAfterRetry[0]?.user_version),
      };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.failed).toBeDefined();
    expect(result.versionAfterFailure).toBe(0);
    expect(result.applied).toBe(1);
    expect(result.versionAfterRetry).toBe(1);
  });
});
