import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanonicalResourceRegion,
  parse,
  type ResourceAddress,
  ResourceBoundaryRevision,
} from "@arbor/domain";
import {
  DomainEventJournal,
  type DomainEventJournalError,
  EnvironmentRevisionStore,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { P35_MIGRATIONS, runMigrations } from "../../src/index.js";
import {
  address,
  FakeEnvironment,
  fakeEnvironmentResolver,
  gitWorktreeAddress,
  makeApp,
  OBSERVED,
  projectId,
  runInApp,
  seed,
  seedActivationBoundaryAndIntent,
  seedGitWorktreeActivationBoundaryAndIntent,
  tempRoots,
  workspaceId,
} from "./support.js";

describe("ownership write service", () => {
  it("activates the pinned Workspace boundary once and returns AlreadyActive on replay", async () => {
    let resolveCalls = 0;
    const environment = Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_projectId, addresses) =>
        Effect.sync(() => {
          resolveCalls += 1;
          return {
            regions: addresses.map(
              (candidate): CanonicalResourceRegion => ({
                resourceSpaceId: "filesystem",
                normalizedRegion: candidate,
              }),
            ),
            observedEnvironmentRevision: OBSERVED,
          };
        }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const intents = yield* WorkspaceResourceActivationStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const first = yield* ownership.activatePendingWorkspaceResource(
        projectId,
        workspaceId,
        parse(ResourceBoundaryRevision)(1),
        [address],
      );
      const replay = yield* ownership.activatePendingWorkspaceResource(
        projectId,
        workspaceId,
        parse(ResourceBoundaryRevision)(1),
        [address],
      );
      const intent = yield* tx.transact(
        intents.find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const events = yield* sql.unsafe<{
        event_type: string;
        event_version: number;
        actor: string;
        aggregate_ref: string;
        payload_json: string;
      }>(
        `SELECT event_type, event_version, actor, aggregate_ref, payload_json
           FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'
          ORDER BY sequence`,
      );
      return { first, replay, intent, claims, events };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(environment)),
    );
    expect(result.first).toEqual({ _tag: "Activated" });
    expect(result.replay).toEqual({ _tag: "AlreadyActive" });
    expect(resolveCalls).toBe(1);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value).toMatchObject({
        status: "Active",
        resourceBoundaryRevision: 1,
        activatedAt: expect.any(String),
      });
    }
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      workspaceId,
      region: {
        resourceSpaceId: "filesystem",
        normalizedRegion: address,
      },
      sourceAddressSnapshot: address,
      resourceBoundaryRevision: 1,
      resolvedAtEnvironmentRevision: OBSERVED,
      releasedAt: null,
    });
    expect(result.events).toHaveLength(1);
    expect(
      result.events.map((event) => ({
        ...event,
        payload_json: JSON.parse(event.payload_json) as unknown,
      })),
    ).toEqual([
      {
        event_type: "WorkspaceResourceActivationChanged",
        event_version: 1,
        actor: "system:workspace-resource-activation",
        aggregate_ref: workspaceId,
        payload_json: {
          _tag: "WorkspaceResourceActivationChanged",
          workspaceId,
          resourceBoundaryRevision: 1,
          status: "Active",
        },
      },
    ]);
  });

  it("refuses a caller boundary that differs from the persisted Workspace", async () => {
    let resolveCalls = 0;
    const environment = Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_projectId, addresses) =>
        Effect.sync(() => {
          resolveCalls += 1;
          return {
            regions: addresses.map(
              (candidate): CanonicalResourceRegion => ({
                resourceSpaceId: "filesystem",
                normalizedRegion: candidate,
              }),
            ),
            observedEnvironmentRevision: OBSERVED,
          };
        }),
    });
    const alternate: ResourceAddress = {
      _tag: "FileTree",
      path: "C:/other-boundary",
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const revisions = yield* EnvironmentRevisionStore;
      const sql = yield* SqlClient;
      const anchorBefore = yield* tx.transact(revisions.current(projectId));
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [alternate],
        )
        .pipe(Effect.flip);
      const intent = yield* tx.transact(
        (yield* WorkspaceResourceActivationStore).find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const anchorAfter = yield* tx.transact(revisions.current(projectId));
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        failure,
        intent,
        claims,
        anchorBefore,
        anchorAfter,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(environment)),
    );
    expect(result.failure).toMatchObject({
      _tag: "PersistenceCorruption",
      repository: "WorkspaceResourceActivationStore",
    });
    expect(resolveCalls).toBe(0);
    expect(result.claims).toEqual([]);
    expect(Option.isNone(result.anchorBefore)).toBe(true);
    expect(Option.isNone(result.anchorAfter)).toBe(true);
    expect(result.eventCount).toBe(0);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
    }
  });

  it("fails closed when activation has no full resource-availability resolver", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const intents = yield* WorkspaceResourceActivationStore;
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [address],
        )
        .pipe(Effect.flip);
      return {
        failure,
        claims: yield* tx.transact(
          repository.listActiveByWorkspace(workspaceId),
        ),
        intent: yield* tx.transact(
          intents.find(
            projectId,
            workspaceId,
            parse(ResourceBoundaryRevision)(1),
          ),
        ),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(
        program,
        makeApp(FakeEnvironment, undefined, ":memory:", null),
      ),
    );
    expect(result.failure).toMatchObject({ _tag: "EnvironmentError" });
    expect(result.claims).toEqual([]);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
    }
  });

  it("fails closed when a GitWorktree probe reports exists:false", async () => {
    const missingGitWorktreeResolver = fakeEnvironmentResolver(
      (candidate) => candidate._tag !== "GitWorktree",
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedGitWorktreeActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const intents = yield* WorkspaceResourceActivationStore;
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [gitWorktreeAddress],
        )
        .pipe(Effect.flip);
      return {
        failure,
        claims: yield* tx.transact(
          repository.listActiveByWorkspace(workspaceId),
        ),
        intent: yield* tx.transact(
          intents.find(
            projectId,
            workspaceId,
            parse(ResourceBoundaryRevision)(1),
          ),
        ),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(
        program,
        makeApp(
          FakeEnvironment,
          undefined,
          ":memory:",
          missingGitWorktreeResolver,
        ),
      ),
    );
    expect(result.failure).toMatchObject({ _tag: "EnvironmentError" });
    expect(result.claims).toEqual([]);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
    }
  });

  it("serializes competing Pending activations to one claim, CAS, and Active event", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-f21-activation-race-"));
    tempRoots.push(root);
    const databaseFile = join(root, "activation.db");
    const daemonA = makeApp(FakeEnvironment, undefined, databaseFile);
    const daemonB = makeApp(FakeEnvironment, undefined, databaseFile);
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
    });
    await runInApp(setup, daemonA);

    const activate = Effect.gen(function* () {
      const ownership = yield* OwnershipWriteService;
      return yield* ownership.activatePendingWorkspaceResource(
        projectId,
        workspaceId,
        parse(ResourceBoundaryRevision)(1),
        [address],
      );
    });
    const [resultA, resultB] = await Promise.all([
      runInApp(activate, daemonA),
      runInApp(activate, daemonB),
    ]);
    const results = [resultA, resultB];
    const verify = Effect.gen(function* () {
      const repository = yield* ResourceOwnershipRepository;
      const activationStore = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const intents = yield* tx.transact(
        activationStore.find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        claims,
        intents,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await runInApp(verify, daemonA);
    expect(results.map((entry) => entry._tag).sort()).toEqual([
      "Activated",
      "AlreadyActive",
    ]);
    expect(result.claims).toHaveLength(1);
    expect(Option.isSome(result.intents)).toBe(true);
    if (Option.isSome(result.intents)) {
      expect(result.intents.value.status).toBe("Active");
    }
    expect(result.eventCount).toBe(1);
  });

  it("rolls claims and Pending→Active back when the Active event append fails", async () => {
    const journalFailure: DomainEventJournalError = {
      _tag: "PersistenceUnavailable",
      repository: "DomainEventJournal",
      operation: "append",
      retryDisposition: "retryable",
      sourceTag: "InjectedFailure",
      cause: "before event commit",
    };
    const failingJournal = Layer.succeed(DomainEventJournal, {
      append: () => Effect.fail(journalFailure),
      appendReturningIds: () => Effect.fail(journalFailure),
      readAfter: () => Effect.succeed([]),
      readAfterRaw: () => Effect.succeed([]),
      decodeRaw: () =>
        Effect.succeed({
          _tag: "Poison" as const,
          reason: "MalformedEnvelope" as const,
        }),
      lastSequence: () => Effect.succeed(0),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const intents = yield* WorkspaceResourceActivationStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const revisions = yield* EnvironmentRevisionStore;
      const sql = yield* SqlClient;
      const anchorBefore = yield* tx.transact(revisions.current(projectId));
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [address],
        )
        .pipe(Effect.flip);
      const intent = yield* tx.transact(
        intents.find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const anchorAfter = yield* tx.transact(revisions.current(projectId));
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        failure,
        intent,
        claims,
        anchorBefore,
        anchorAfter,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(FakeEnvironment, failingJournal)),
    );
    expect(result.failure).toEqual(journalFailure);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
      expect(result.intent.value.activatedAt).toBeNull();
    }
    expect(result.claims).toEqual([]);
    expect(Option.isNone(result.anchorBefore)).toBe(true);
    expect(Option.isNone(result.anchorAfter)).toBe(true);
    expect(result.eventCount).toBe(0);
  });
});
