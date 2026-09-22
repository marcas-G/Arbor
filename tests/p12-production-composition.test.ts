import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  P12_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  buildSliceLayer,
  type SliceServices,
} from "../apps/single-workspace/src/composition.js";
import { runDaemonOnce } from "../apps/single-workspace/src/main.js";
import {
  ProductionDaemonService,
  TransportBoundary,
} from "../apps/single-workspace/src/production.js";
import { makeStaticAuthenticator } from "../apps/single-workspace/src/transport/auth.js";
import {
  AuthorityResolverPort,
  CommandGateway,
  type CreateProjectPayload,
  RemoteWorkerMediationPort,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  HealthPort,
  PersistenceHealthProbe,
  ProjectionQueryPort,
  RunnableWorkSource,
  ToolCatalogPort,
  TransactionPort,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import { UsageService } from "../packages/projection-runtime/src/index.js";
import { p7Project, p7RootWorkspace, p7SeedProject } from "./support/p7-app.js";

/**
 * B-6 / B-7 / B-8 — the production composition root is the single runtime:
 *  - B-6: it wires the P7 dependency-aware `RunnableWorkSource`, not the P5
 *    provisional one;
 *  - B-7: it assembles the Authority Resolver, transport boundary, worker
 *    mediation, projection query face, production daemon, observability and
 *    catalog, and provides a runnable daemon entrypoint;
 *  - B-8: it provides the real production `HealthPort` over
 *    `PRAGMA user_version` + T1 recovery state.
 */

const suiteTmp = mkdtempSync(join(tmpdir(), "p12-production-"));
afterAll(() => {
  rmSync(suiteTmp, { recursive: true, force: true });
});

const HUMAN = parse(Principal)("user:governance");
const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789f1");
const WORKSPACE = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789f1");
const SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789f1");
const WORK = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789f1");
const ACTOR = parse(Actor)("user:governance");
const ISSUED_AT = "2026-09-22T00:00:00.000Z";

const createProjectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: WORKSPACE,
  primarySession: {
    sessionId: SESSION,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: {
      purpose: "p",
      ownedResponsibilities: [],
      obligations: [],
      includes: [],
      excludes: [],
      interfaces: [],
    },
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(WORKSPACE),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const buildLayer = (dbFile: string) =>
  buildSliceLayer({
    databaseFile: dbFile,
    projectId: PROJECT,
    authenticator: makeStaticAuthenticator({ "test-token": HUMAN }),
    governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
  });

const runWith = <A>(
  dbFile: string,
  program: Effect.Effect<A, unknown, SliceServices>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, buildLayer(dbFile))),
  ) as Promise<A>;

describe("p12 production composition (B-6 / B-7 / B-8)", () => {
  it("B-6: production wires the P7 dependency-aware RunnableWorkSource (a waiting Open work is not runnable)", async () => {
    const dir = mkdtempSync(join(suiteTmp, "b6-"));
    const outcome = await runWith(
      join(dir, "slice.db"),
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* p7SeedProject;
        // one Open work on the seeded root workspace
        const gateway = yield* CommandGateway;
        const workPayload = {
          workId: WORK,
          workspaceId: p7RootWorkspace,
          expectedWorkspaceRevision: parse(Revision)(0),
          objective: "b6",
          why: "b6",
          constraints: [],
          completionExpectation: "green",
          verificationMission: {
            goal: "g",
            criteria: [],
            riskRequirements: [],
          },
          provenance: { predecessorWorkId: null, reason: "seed" },
          revision: parse(WorkRevision)(0),
        };
        yield* gateway.execute(
          {
            commandType: "AssignWork",
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789f2",
            ),
            projectId: p7Project,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: workPayload,
          },
          { _tag: "External", principal: HUMAN },
          {
            _tag: "AssignWorkAuthority",
            principal: HUMAN,
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789f2",
            ),
            semanticRequestFingerprint: semanticRequestFingerprint({
              commandType: "AssignWork",
              projectId: p7Project,
              actor: ACTOR,
              schemaVersion: "1",
              payload: workPayload,
            }),
            projectId: p7Project,
            targetWorkspaceId: p7RootWorkspace,
          } as VerifiedCommandAuthority,
        );

        const source = yield* RunnableWorkSource;
        const before = yield* source.classify(p7RootWorkspace);

        // register an active wait on the Open work
        const tx = yield* TransactionPort;
        const waits = yield* WorkWaitStore;
        yield* tx.transact(
          waits.upsert({
            workId: WORK,
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            registeredAt: "t",
            updatedAt: "t",
          }),
        );
        const after = yield* source.classify(p7RootWorkspace);
        return { before, after };
      }),
    );

    expect(outcome.before.runnable).toContain(WORK);
    // P7 semantics: a waiting Work is excluded from the runnable set (the P5
    // provisional source would have kept it runnable).
    expect(outcome.after.runnable).not.toContain(WORK);
  });

  it("B-7/B-8: the composition assembles resolver, transport, worker mediation, daemons, observability, health and catalog", async () => {
    const dir = mkdtempSync(join(suiteTmp, "b7-"));
    const outcome = await runWith(
      join(dir, "slice.db"),
      Effect.gen(function* () {
        const health = yield* HealthPort;
        const beforeMigration = yield* health.readiness();

        yield* runMigrations(P12_MIGRATIONS);
        const afterMigration = yield* health.readiness();

        const resolver = yield* AuthorityResolverPort;
        const mediation = yield* RemoteWorkerMediationPort;
        const query = yield* ProjectionQueryPort;
        const boundary = yield* TransportBoundary;
        const usage = yield* UsageService;
        const catalog = yield* ToolCatalogPort;
        const probe = yield* PersistenceHealthProbe;
        const deployment = yield* ProductionDaemonService;

        // T1 recovery runs exactly once at daemon start and flips readiness.
        yield* deployment.daemon.start;
        const afterRecovery = yield* health.readiness();
        yield* deployment.daemon.pollConsumers;
        yield* deployment.daemon.recoveryTick;

        // transport boundary: authenticated external command -> resolver ->
        // gateway, then a real view query over the projection query face.
        const createResponse = yield* boundary.http.handle({
          method: "POST",
          path: "/commands",
          authorization: "Bearer test-token",
          body: {
            commandType: "CreateProject",
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789f3",
            ),
            projectId: PROJECT,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: createProjectPayload(),
          },
        });
        const treeResponse = yield* boundary.http.handle({
          method: "POST",
          path: "/views/responsibility-tree",
          body: { projectId: PROJECT },
        });

        return {
          beforeMigration,
          afterMigration,
          afterRecovery,
          probe,
          resolver,
          mediation,
          query,
          usage,
          catalog,
          deployment,
          createResponse,
          treeResponse,
        };
      }),
    );

    // B-8 readiness transitions
    expect(outcome.beforeMigration.dbOpen).toBe(true);
    expect(outcome.beforeMigration.migrationBaseline).toBe(false);
    expect(outcome.afterMigration.migrationBaseline).toBe(true);
    expect(outcome.afterMigration.t1RecoveryComplete).toBe(false);
    expect(outcome.afterRecovery.t1RecoveryComplete).toBe(true);
    expect(
      outcome.afterRecovery.dbOpen &&
        outcome.afterRecovery.migrationBaseline &&
        outcome.afterRecovery.t1RecoveryComplete,
    ).toBe(true);
    expect(typeof outcome.probe.probe).toBe("function");

    // B-7 assembly
    expect(typeof outcome.resolver.resolve).toBe("function");
    expect(typeof outcome.resolver.resolveInvocation).toBe("function");
    expect(typeof outcome.mediation.submit).toBe("function");
    expect(typeof outcome.query.query).toBe("function");
    expect(typeof outcome.usage.derive).toBe("function");
    expect(typeof outcome.catalog.visibleRefs).toBe("function");
    expect(outcome.deployment.consumers.length).toBeGreaterThan(0);
    expect(typeof outcome.deployment.driftWatcher.trigger).toBe("function");
    expect(outcome.deployment.daemon.start).toBeDefined();
    expect(outcome.deployment.daemon.pollConsumers).toBeDefined();
    expect(outcome.deployment.daemon.recoveryTick).toBeDefined();

    // B-7 transport end-to-end: command committed + real view query rendered.
    expect(outcome.createResponse.ok).toBe(true);
    if (outcome.createResponse.ok) {
      const body = outcome.createResponse.body as {
        readonly resolution: string;
      };
      expect(body.resolution).toBe("Committed");
    }
    expect(outcome.treeResponse.ok).toBe(true);
    if (outcome.treeResponse.ok) {
      const body = outcome.treeResponse.body as {
        readonly value?: { readonly nodes: ReadonlyArray<unknown> };
      };
      expect(body.value?.nodes.length).toBeGreaterThan(0);
    }
  });

  it("B-7: the production daemon entrypoint smoke-runs (migrate -> T1 -> scheduler/loop -> consumers -> sweep)", async () => {
    const dir = mkdtempSync(join(suiteTmp, "daemon-"));
    const outcome = await runWith(
      join(dir, "slice.db"),
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* p7SeedProject;
        const deployment = yield* ProductionDaemonService;
        // the runnable entrypoint: start (migrations + T1 recovery), scheduler
        // loop, consumer polls, recovery sweep.
        yield* runDaemonOnce({
          workspaceId: p7RootWorkspace,
          principalRef: "runtime:system",
        });
        const health = yield* HealthPort;
        return { readiness: yield* health.readiness(), deployment };
      }),
    );
    expect(outcome.readiness.dbOpen).toBe(true);
    expect(outcome.readiness.migrationBaseline).toBe(true);
    expect(outcome.readiness.t1RecoveryComplete).toBe(true);
    expect(outcome.deployment.consumers).toHaveLength(2);
  });

  it("B-7: production no longer references the P5 provisional runnable source", () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "apps",
        "single-workspace",
        "src",
        "composition.ts",
      ),
      "utf8",
    );
    expect(source).toContain("DependencyAwareRunnableWorkSourceLive");
    expect(source).not.toContain("ProvisionalRunnableWorkSourceLive");
    expect(source).toContain("AuthorityResolverPortLive");
    expect(source).toContain("RemoteWorkerMediationPortLive");
    expect(source).toContain("TransportBoundaryLive");
    expect(source).toContain("ProductionDaemonServiceLive");
    expect(source).toContain("PersistenceHealthProbeSqliteLive");
    expect(source).toContain("ProjectionQueryPortLive");
    expect(source).toContain("ToolCatalogPortLive");
  });
});
