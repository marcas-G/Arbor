import {
  type CanonicalResourceRegion,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  ProjectId,
  parse,
  type ResourceAddress,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  EnvironmentRevisionStore,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ProjectRepository,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  SessionRepository,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  OwnershipWriteServiceLive,
  P1_MIGRATIONS,
  ProjectRepositoryLive,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
} from "../src/index.js";

const OBSERVED = "rev-observed";

const FakeEnvironment: Layer.Layer<ProjectEnvironmentPort> = Layer.succeed(
  ProjectEnvironmentPort,
  {
    resolve: (_projectId, addresses) =>
      Effect.sync(() => ({
        regions: addresses.map(
          (address): CanonicalResourceRegion => ({
            resourceSpaceId:
              address._tag === "DatabaseNamespace" ? "database" : "filesystem",
            normalizedRegion: address,
          }),
        ),
        observedEnvironmentRevision: OBSERVED,
      })),
  },
);

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const services = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    FakeEnvironment,
  );
  return Layer.mergeAll(
    infra,
    services,
    Layer.provide(OwnershipWriteServiceLive, services),
  );
};

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
const boundary = {
  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
  addresses: [],
};

const seed = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const projects = yield* ProjectRepository;
  const workspaces = yield* WorkspaceRepository;
  const sessions = yield* SessionRepository;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* projects.create({
        projectId,
        name: "Arbor",
        rootWorkspaceId: workspaceId,
        projectPolicy: makeProjectPolicy(),
        projectPolicyRevision: parse(Revision)(0),
        defaultConfiguration: {},
        environmentRef: "local",
        lifecycle: "Open",
        revision: parse(Revision)(0),
      });
      yield* workspaces.create({
        workspaceId,
        projectId,
        parentWorkspaceId: null,
        name: "root",
        responsibilityDefinition: definition,
        responsibilityRevision: parse(ResponsibilityRevision)(0),
        resourceBoundary: boundary,
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
        agentBinding: responsibilityBound(workspaceId),
        primarySessionId: sessionId,
        currentWorkId: null,
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
        lifecycle: "Active",
      });
      yield* sessions.create({
        sessionId,
        binding: { _tag: "WorkspacePrimary", workspaceId },
        contextEpoch: parse(ContextEpochNumber)(0),
        entries: [],
        checkpoints: [],
        providerContinuation: { state: null },
        modelContinuation: null,
      });
    }),
  );
});

const claim = (id: string, path: string): ResourceOwnershipClaimRecord => ({
  claimId: id,
  workspaceId,
  region: {
    resourceSpaceId: "filesystem",
    normalizedRegion: { kind: "FileTree", path },
  },
  sourceAddressSnapshot: { _tag: "FileTree", path },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
  resolvedAtEnvironmentRevision: OBSERVED,
  createdAt: "t0",
  releasedAt: null,
});

const address: ResourceAddress = { _tag: "FileTree", path: "/repo/a" };

describe("ownership write service", () => {
  it("writes claims and records the observed environment revision", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      const revisions = yield* EnvironmentRevisionStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const result = yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      const current = yield* tx.transact(revisions.current(projectId));
      const active = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      return { result, current, active };
    });
    const { result, current, active } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(result.regions).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
    expect(Option.isSome(current) && current.value).toBe(OBSERVED);
    expect(active.map((entry) => entry.claimId)).toEqual(["c1"]);
    expect(active[0]?.releasedAt).toBeNull();
  });

  it("rejects overlapping active claims", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      return yield* ownership
        .resolveAndWrite(projectId, [address], [claim("c2", "/repo/a/b")])
        .pipe(Effect.flip);
    });
    const error = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(error._tag).toBe("ResourceOwnershipRepositoryFailure");
  });

  it("allows a new claim once the conflicting claim is released", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      yield* tx.transact(repository.releaseClaim("c1", "t1"));
      return yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c2", "/repo/a/b")],
      );
    });
    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.claims.map((entry) => entry.claimId)).toEqual(["c2"]);
  });

  it("fails with ResourceResolutionStale when the revision moved", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const revisions = yield* EnvironmentRevisionStore;
      const ownership = yield* OwnershipWriteService;
      const tx = yield* TransactionPort;
      yield* tx.transact(revisions.record(projectId, "rev-old"));
      return yield* ownership
        .resolveAndWrite(projectId, [address], [claim("c1", "/repo/a")])
        .pipe(Effect.flip);
    });
    const error = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(error._tag).toBe("ResourceResolutionStale");
  });
});
