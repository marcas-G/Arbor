import { parse, ResourceBoundaryRevision } from "@arbor/domain";
import {
  DomainEventJournal,
  type DomainEventJournalError,
  OwnershipWriteService,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import { P35_MIGRATIONS, runMigrations } from "../../src/index.js";
import {
  childWorkspaceId,
  competingWorkspaceId,
  FakeEnvironment,
  makeApp,
  projectId,
  runInApp,
  seed,
  seedCompetingDelegatedScopeOwner,
  seedDelegatedOwnershipIntent,
  workspaceId,
} from "./support.js";

describe("ownership write service", () => {
  it.effect(
    "rolls back the complete delegated post-image when the ownership event fails",
    () =>
      Effect.gen(function* () {
        const journalFailure: DomainEventJournalError = {
          _tag: "PersistenceUnavailable",
          repository: "DomainEventJournal",
          operation: "append",
          retryDisposition: "retryable",
          sourceTag: "InjectedFailure",
          cause: "before ownership event commit",
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
          yield* seedDelegatedOwnershipIntent();
          const ownership = yield* OwnershipWriteService;
          const repository = yield* ResourceOwnershipRepository;
          const activations = yield* WorkspaceResourceActivationStore;
          const tx = yield* TransactionPort;
          const sql = yield* SqlClient;
          const failure = yield* ownership
            .activateDelegatedOwnership({
              projectId,
              childWorkspaceId,
              childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
              delegationSourceId: "formation:proposal-s3-1:1",
            })
            .pipe(Effect.flip);
          const parentClaims = yield* tx.transact(
            repository.listActiveByWorkspace(workspaceId),
          );
          const childClaims = yield* tx.transact(
            repository.listActiveByWorkspace(childWorkspaceId),
          );
          const intent = yield* tx.transact(
            activations.find(
              projectId,
              childWorkspaceId,
              parse(ResourceBoundaryRevision)(1),
            ),
          );
          const events = yield* sql.unsafe<{ count: number }>(
            `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type IN ('ResourceOwnershipChanged',
                               'WorkspaceResourceActivationChanged')`,
          );
          return {
            failure,
            parentClaims,
            childClaims,
            intent,
            eventCount: Number(events[0]?.count ?? 0),
          };
        });
        const result = yield* Effect.provide(
          program,
          makeApp(FakeEnvironment, failingJournal),
        );
        expect(result.failure).toEqual(journalFailure);
        expect(result.parentClaims).toHaveLength(1);
        expect(result.parentClaims[0]?.claimRevision).toBe(0);
        expect(result.parentClaims[0]?.exclusions).toEqual([]);
        expect(result.childClaims).toEqual([]);
        expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
          "Pending",
        );
        expect(result.eventCount).toBe(0);
      }),
  );

  it("rejects a stale Parent Workspace revision before any delegation write", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "UPDATE workspaces SET revision = 2 WHERE workspace_id = ?",
        [workspaceId],
      );
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const result = yield* ownership
        .activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        })
        .pipe(Effect.flip);
      const parentClaims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const childClaims = yield* tx.transact(
        repository.listActiveByWorkspace(childWorkspaceId),
      );
      const intent = yield* tx.transact(
        activations.find(
          projectId,
          childWorkspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      return { result, parentClaims, childClaims, intent };
    });
    const result = await runInApp(program, makeApp());
    expect(result.result._tag).toBe("WorkspaceRepositoryRevisionConflict");
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(0);
    expect(result.parentClaims[0]?.exclusions).toEqual([]);
    expect(result.childClaims).toEqual([]);
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Pending",
    );
  });

  it("rejects a globally overlapping effective post-image without partial ownership writes", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      yield* seedCompetingDelegatedScopeOwner;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const failure = yield* ownership
        .activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        })
        .pipe(Effect.flip);
      const parentClaims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const childClaims = yield* tx.transact(
        repository.listActiveByWorkspace(childWorkspaceId),
      );
      const competingClaims = yield* tx.transact(
        repository.listActiveByWorkspace(competingWorkspaceId),
      );
      const intent = yield* tx.transact(
        activations.find(
          projectId,
          childWorkspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'ResourceOwnershipChanged'`,
      );
      return {
        failure,
        parentClaims,
        childClaims,
        competingClaims,
        intent,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await runInApp(program, makeApp());
    expect(result.failure).toMatchObject({
      _tag: "PersistenceConstraintViolation",
      repository: "ResourceOwnershipRepository",
      constraint: "effective-resource-ownership-overlap",
    });
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(0);
    expect(result.parentClaims[0]?.exclusions).toEqual([]);
    expect(result.childClaims).toEqual([]);
    expect(result.competingClaims).toHaveLength(1);
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Pending",
    );
    expect(result.eventCount).toBe(0);
  });
});
