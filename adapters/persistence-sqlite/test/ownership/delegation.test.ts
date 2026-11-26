import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Actor,
  CommandId,
  parse,
  type ResourceAddress,
  ResourceBoundaryRevision,
} from "@arbor/domain";
import {
  EnvironmentRevisionStore,
  OwnershipWriteService,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { P35_MIGRATIONS, runMigrations } from "../../src/index.js";
import {
  childWorkspaceId,
  FakeEnvironment,
  makeApp,
  projectId,
  runInApp,
  seed,
  seedDelegatedOwnershipIntent,
  tempRoots,
  workspaceId,
} from "./support.js";

describe("ownership write service", () => {
  it("atomically activates, replays, and serializes one exact delegation", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-s3-delegation-race-"));
    tempRoots.push(root);
    const databaseFile = join(root, "delegation.db");
    const daemonA = makeApp(FakeEnvironment, undefined, databaseFile);
    const daemonB = makeApp(FakeEnvironment, undefined, databaseFile);
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
    });
    await runInApp(setup, daemonA);

    const activation = Effect.gen(function* () {
      const ownership = yield* OwnershipWriteService;
      return yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
    });
    const raced = await Promise.all([
      runInApp(activation, daemonA),
      runInApp(activation, daemonB),
    ]);
    const replay = await runInApp(activation, daemonA);
    const verify = Effect.gen(function* () {
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
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
      const events = yield* sql.unsafe<{
        event_type: string;
        event_version: number;
        actor: string;
        caused_by_command_id: string | null;
        payload_json: string;
      }>(
        `SELECT event_type, event_version, actor, caused_by_command_id,
                payload_json
           FROM domain_events
          WHERE event_type IN ('ResourceOwnershipChanged',
                               'WorkspaceResourceActivationChanged')
          ORDER BY sequence`,
      );
      return { parentClaims, childClaims, intent, events };
    });
    const result = await runInApp(verify, daemonA);
    expect(raced.map((item) => item._tag).sort()).toEqual([
      "Activated",
      "AlreadyActive",
    ]);
    expect(replay._tag).toBe("AlreadyActive");
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(1);
    expect(
      result.parentClaims[0]?.exclusions?.map((entry) =>
        JSON.stringify(entry.normalizedRegion),
      ),
    ).toEqual(['{"_tag":"FileTree","path":"/repo/child"}']);
    expect(result.childClaims).toHaveLength(1);
    expect(result.childClaims[0]).toMatchObject({
      delegatingWorkspaceId: workspaceId,
      delegationSourceId: "formation:proposal-s3-1:1",
      claimRevision: 1,
      region: {
        resourceSpaceId: "filesystem",
        normalizedRegion: { _tag: "FileTree", path: "/repo/child" },
      },
    });
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Active",
    );
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      event_type: "ResourceOwnershipChanged",
      event_version: 2,
      actor: "user:gaolei",
      caused_by_command_id: "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
    });
    const eventPayload = JSON.parse(result.events[0]?.payload_json ?? "null");
    expect(eventPayload).toMatchObject({
      _tag: "ResourceOwnershipChanged",
      operation: "Delegated",
      delegation: {
        delegationSourceId: "formation:proposal-s3-1:1",
        parentWorkspaceId: workspaceId,
        childWorkspaceId,
      },
      parentClaim: {
        exclusions: [
          {
            resourceSpaceId: "filesystem",
            normalizedRegion: { _tag: "FileTree", path: "/repo/child" },
          },
        ],
      },
      childClaim: {
        delegationSourceId: "formation:proposal-s3-1:1",
      },
    });
    expect(
      result.events.filter(
        (event) => event.event_type === "ResourceOwnershipChanged",
      ),
    ).toHaveLength(1);
  });

  it("reclaims only the exact delegated Child region and commits ownership and retirement together", async () => {
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      return yield* ownership.reclaimDelegatedOwnership({
        projectId,
        childWorkspaceId,
        delegationSourceId: "formation:proposal-s3-1:1",
        expectedParentWorkspaceRevision: 1,
        expectedChildWorkspaceRevision: 0,
        expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedParentClaimRevision: 1,
        expectedChildClaimRevision: 1,
        actor: parse(Actor)("user:gaolei"),
        causedByCommandId: parse(CommandId)(
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
        ),
        retireChild: true,
        quiescence: {
          noUnresolvedEffects: true,
          noActiveExecution: true,
          noOpenWork: true,
          noActiveChildren: true,
          noUnresolvedIncomingDependencies: true,
        },
      });
    });
    const result = await runInApp(setup, makeApp());
    expect(result._tag).toBe("Reclaimed");
    expect(result.childRetired).toBe(true);
    expect(result.parentClaim.exclusions).toEqual([]);
    expect(result.parentClaim.claimRevision).toBe(2);
    expect(result.childClaim.releasedAt).not.toBeNull();
  });

  it("rejects reclaim when the resolved environment revision is no longer anchored", async () => {
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const revisions = yield* EnvironmentRevisionStore;
      const tx = yield* TransactionPort;
      yield* tx.transact(revisions.record(projectId, "rev-newer"));
      const reclaimExit = yield* Effect.exit(
        ownership.reclaimDelegatedOwnership({
          projectId,
          childWorkspaceId,
          delegationSourceId: "formation:proposal-s3-1:1",
          expectedParentWorkspaceRevision: 1,
          expectedChildWorkspaceRevision: 0,
          expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedParentClaimRevision: 1,
          expectedChildClaimRevision: 1,
          actor: parse(Actor)("user:gaolei"),
          causedByCommandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
          ),
          retireChild: false,
          quiescence: {
            noUnresolvedEffects: true,
            noActiveExecution: true,
            noOpenWork: true,
            noActiveChildren: true,
            noUnresolvedIncomingDependencies: true,
          },
        }),
      );
      return reclaimExit;
    });
    const result = await runInApp(setup, makeApp());
    expect(result._tag).toBe("Failure");
  });

  it("rejects reclaim when canonical open Work appears despite all caller flags", async () => {
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const sql = yield* SqlClient;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        sql.unsafe(
          "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES ('wrk_s3_reclaim_open','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','objective','why','[]','done','[]','{}','Open',0,'t0','t0')",
        ),
      );
      return yield* Effect.exit(
        ownership.reclaimDelegatedOwnership({
          projectId,
          childWorkspaceId,
          delegationSourceId: "formation:proposal-s3-1:1",
          expectedParentWorkspaceRevision: 1,
          expectedChildWorkspaceRevision: 0,
          expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedParentClaimRevision: 1,
          expectedChildClaimRevision: 1,
          actor: parse(Actor)("user:gaolei"),
          causedByCommandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
          ),
          retireChild: false,
          quiescence: {
            noUnresolvedEffects: true,
            noActiveExecution: true,
            noOpenWork: true,
            noActiveChildren: true,
            noUnresolvedIncomingDependencies: true,
          },
        }),
      );
    });
    expect((await runInApp(setup, makeApp()))._tag).toBe("Failure");
  });

  it.each([
    "active-execution",
    "unresolved-effect",
    "incoming-dependency",
  ] as const)(
    "rejects reclaim for canonical %s despite all caller flags",
    async (scenario) => {
      const setup = Effect.gen(function* () {
        yield* runMigrations(P35_MIGRATIONS);
        yield* seed;
        yield* seedDelegatedOwnershipIntent();
        const ownership = yield* OwnershipWriteService;
        yield* ownership.activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        if (scenario === "active-execution") {
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe_s3_active','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','workspace','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','WorkEpisode','wrk_s3_active',0,NULL,NULL,'ses_018f2b3c-4d5e-7abc-8def-0123456789ac','t0',NULL,NULL,NULL,NULL)",
            ),
          );
        } else if (scenario === "unresolved-effect") {
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe_s3_effect','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','workspace','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','WorkEpisode','wrk_s3_effect',0,NULL,NULL,'ses_018f2b3c-4d5e-7abc-8def-0123456789ac','t0',NULL,'Completed','{}','t1')",
            ),
          );
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES ('inv_s3_effect','exe_s3_effect','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','patch','1','NonIdempotent','{}','[{\"resourceSpaceId\":\"filesystem\",\"normalizedRegion\":{\"kind\":\"FileTree\",\"path\":\"/repo/child\"}}]',NULL,'t0',NULL,NULL,NULL,NULL)",
            ),
          );
        } else {
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES ('wrk_s3_consumer','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','ws_018f2b3c-4d5e-7abc-8def-0123456789ab','consumer','why','[]','done','[]','{}','Open',0,'t0','t0')",
            ),
          );
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES ('dep_s3_incoming','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','wrk_s3_consumer',?,'{}',0,'Unsatisfied',NULL,NULL,'t0','t0')",
              [
                JSON.stringify({
                  _tag: "WorkspaceBound",
                  workspaceId: childWorkspaceId,
                }),
              ],
            ),
          );
        }
        return yield* Effect.exit(
          ownership.reclaimDelegatedOwnership({
            projectId,
            childWorkspaceId,
            delegationSourceId: "formation:proposal-s3-1:1",
            expectedParentWorkspaceRevision: 1,
            expectedChildWorkspaceRevision: 0,
            expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            expectedParentClaimRevision: 1,
            expectedChildClaimRevision: 1,
            actor: parse(Actor)("user:gaolei"),
            causedByCommandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
            ),
            retireChild: false,
            quiescence: {
              noUnresolvedEffects: true,
              noActiveExecution: true,
              noOpenWork: true,
              noActiveChildren: true,
              noUnresolvedIncomingDependencies: true,
            },
          }),
        );
      });
      expect((await runInApp(setup, makeApp()))._tag).toBe("Failure");
    },
  );

  it("transfers and reclaims an equality-only external region without exclusions", async () => {
    const externalAddress: ResourceAddress = {
      _tag: "ExternalResource",
      address: "https://example.test/exact-resource",
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent(externalAddress);
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const replay = yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const repo = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const parentAfterTransfer = yield* tx.transact(
        repo.listActiveByWorkspace(workspaceId),
      );
      const childAfterTransfer = yield* tx.transact(
        repo.listActiveByWorkspace(childWorkspaceId),
      );
      const reclaim = yield* ownership.reclaimDelegatedOwnership({
        projectId,
        childWorkspaceId,
        delegationSourceId: "formation:proposal-s3-1:1",
        expectedParentWorkspaceRevision: 1,
        expectedChildWorkspaceRevision: 0,
        expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedParentClaimRevision: 1,
        expectedChildClaimRevision: 1,
        actor: parse(Actor)("user:gaolei"),
        causedByCommandId: parse(CommandId)(
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
        ),
        retireChild: false,
        quiescence: {
          noUnresolvedEffects: true,
          noActiveExecution: true,
          noOpenWork: true,
          noActiveChildren: true,
          noUnresolvedIncomingDependencies: true,
        },
      });
      const parentAfterReclaim = yield* tx.transact(
        repo.listActiveByWorkspace(workspaceId),
      );
      const childAfterReclaim = yield* tx.transact(
        repo.listActiveByWorkspace(childWorkspaceId),
      );
      return {
        parentAfterTransfer,
        childAfterTransfer,
        replay,
        reclaim,
        parentAfterReclaim,
        childAfterReclaim,
      };
    });
    const result = await runInApp(program, makeApp());
    expect(result.parentAfterTransfer).toEqual([]);
    expect(result.childAfterTransfer).toHaveLength(1);
    expect(result.replay._tag).toBe("AlreadyActive");
    expect(result.reclaim._tag).toBe("Reclaimed");
    expect(result.parentAfterReclaim).toHaveLength(1);
    expect(result.parentAfterReclaim[0]?.exclusions).toEqual([]);
    expect(result.childAfterReclaim).toEqual([]);
  });
});
