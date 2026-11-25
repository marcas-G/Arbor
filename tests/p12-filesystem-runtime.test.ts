import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { makeBlobStorePortLive } from "../adapters/blob-local/src/index.js";
import {
  EnvironmentResolverLocalLive,
  ProjectEnvironmentPortFromResolverLive,
} from "../adapters/environment-resolver-local/src/index.js";
import {
  ArtifactMetadataRepositoryLive,
  ClockLive,
  EnvironmentRevisionStoreLive,
  makeP39RecoveryEvidenceStoreLive,
  ResourceOwnershipRepositoryLive,
  layer as sqliteLayer,
  ToolInvocationStoreLive,
  ToolObservationEvidenceStoreLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { SandboxPortLive } from "../adapters/sandbox-local/src/index.js";
import {
  Actor,
  type CanonicalResourceRegion,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  ResourceBoundaryRevision,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  invocationAuthoritySourceRevisionOf,
  ResourceOwnershipRepository,
  type ToolExecutionContext,
  type ToolIntent,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  ArtifactServiceLive,
  BUILTIN_EXECUTORS,
  ResourceAdmissionLive,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
  type ToolRuntimeQualificationProbe,
} from "../packages/tool-runtime/src/index.js";
import {
  type CurrentSchemaTestDatabase,
  createCurrentSchemaTestDatabaseFactory,
} from "./support/schema44-database.js";

// Real current-schema SQLite, resolver, ownership admission, mounted filesystem,
// artifact storage and runtime. This does not qualify an OS process sandbox,
// browser permissions, or daemon crash/restart behavior.
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const identity = (index: number) => {
  const uuid = `018f2b3c-4d5e-7abc-8def-${String(index).padStart(12, "0")}`;
  return {
    workspaceId: parse(WorkspaceId)(`ws_${uuid}`),
    executionId: parse(ExecutionId)(`exe_${uuid}`),
    sessionId: parse(SessionId)(`ses_${uuid}`),
    principal: parse(Principal)(`worker:filesystem-${index}`),
    actor: parse(Actor)(`worker:filesystem-${index}`),
  };
};
const a = identity(1);
const b = identity(2);
const region = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path },
});
const target = (path = ".") => ({ mount: "workspace", path });
let factory: Awaited<ReturnType<typeof createCurrentSchemaTestDatabaseFactory>>;
let database: CurrentSchemaTestDatabase;
let roots: [string, string];
let nextInvocation = 0;

const seed = (parentWithChild = false) => {
  roots = parentWithChild
    ? [
        join(database.directory, "parent"),
        join(database.directory, "parent/child"),
      ]
    : [join(database.directory, "a"), join(database.directory, "b")];
  for (const root of roots) mkdirSync(root, { recursive: true });
  roots = [realpathSync(roots[0]), realpathSync(roots[1])];
  const db = new DatabaseSync(database.databaseFilename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at)
      VALUES (?, 'filesystem runtime', ?, '{}', 0, '{}', 'local', 'Open', 0, 't', 't')`).run(
      projectId,
      a.workspaceId,
    );
    for (const [index, owner] of [a, b].entries()) {
      db.prepare(`INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at)
        VALUES (?, ?, ?, 'filesystem', '{}', 0, ?, 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't', 't')`).run(
        owner.workspaceId,
        projectId,
        parentWithChild && index === 1 ? a.workspaceId : null,
        JSON.stringify({
          basisResponsibilityRevision: 0,
          addresses: [{ _tag: "FileTree", path: roots[index] }],
        }),
        owner.sessionId,
      );
      db.prepare(`INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at)
        VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't')`).run(
        owner.sessionId,
        owner.workspaceId,
      );
      db.prepare(`INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at)
        VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL, 'filesystem qualification', ?, 't', NULL, NULL, NULL, NULL)`).run(
        owner.executionId,
        projectId,
        owner.workspaceId,
        owner.sessionId,
      );
      db.prepare(`INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at)
        VALUES (?, ?, 'incarnation:filesystem', 0, '2999-01-01T00:00:00.000Z', 't')`).run(
        owner.executionId,
        owner.principal,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};

const makeApp = (trace?: {
  executions: number;
  probe?: ToolRuntimeQualificationProbe;
}) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: database.databaseFilename }),
    ClockLive,
  );
  const ownership = Layer.provide(ResourceOwnershipRepositoryLive, infra);
  const resolver = Layer.provide(EnvironmentResolverLocalLive, infra);
  const deps = Layer.mergeAll(
    infra,
    ownership,
    Layer.provide(ResourceAdmissionLive, ownership),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(ProjectEnvironmentPortFromResolverLive, resolver),
    Layer.provide(makeP39RecoveryEvidenceStoreLive(), infra),
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(ToolObservationEvidenceStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(ArtifactMetadataRepositoryLive, infra),
    makeBlobStorePortLive(join(database.directory, "blobs")),
    SandboxPortLive,
    ToolDefinitionStoreLive,
  );
  const artifacts = Layer.provide(ArtifactServiceLive, deps);
  const executors =
    trace === undefined
      ? BUILTIN_EXECUTORS
      : BUILTIN_EXECUTORS.map((executor) =>
          executor.name !== "write"
            ? executor
            : {
                ...executor,
                execute: (input: Parameters<typeof executor.execute>[0]) =>
                  Effect.suspend(() => {
                    trace.executions++;
                    return executor.execute(input);
                  }),
              },
        );
  return Layer.mergeAll(
    deps,
    Layer.provide(
      ToolRuntimeLive(
        executors,
        trace?.probe === undefined ? {} : { qualificationProbe: trace.probe },
      ),
      Layer.mergeAll(deps, artifacts),
    ),
  );
};

const claim = async (
  owner: typeof a,
  path: string,
  exclusions: string[] = [],
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const ownership = yield* ResourceOwnershipRepository;
        yield* tx.transact(
          ownership.insertClaim({
            claimId: `claim:${owner.workspaceId}`,
            workspaceId: owner.workspaceId,
            region: region(path),
            sourceAddressSnapshot: { _tag: "FileTree", path },
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
            resolvedAtEnvironmentRevision: "0",
            createdAt: "",
            releasedAt: null,
            exclusions: exclusions.map(region),
          }),
        );
      }),
      makeApp(),
    ),
  );

const intent = (
  toolName: "write" | "glob" | "grep" | "patch",
  input: unknown,
): ToolIntent => ({
  invocationId: parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-${String(++nextInvocation).padStart(12, "0")}`,
  ),
  callRef: `call:${nextInvocation}`,
  toolName,
  toolVersion: toolName === "patch" ? "2" : "1",
  argumentsJson: JSON.stringify(input),
  approvalId: null,
});
const context = (owner: typeof a, call: ToolIntent): ToolExecutionContext => ({
  ...owner,
  projectId,
  authenticatedPrincipal: owner.principal,
  controlBasisDigest: "f".repeat(64),
  requestedAt: "2026-11-15T00:00:00.000Z",
  executionFence: {
    executionId: owner.executionId,
    workerId: String(owner.principal),
    workerIncarnationId: "incarnation:filesystem",
    fencingGeneration: parse(LeaseGeneration)(0),
  },
  recoveryBindingIdentity: {
    executionId: owner.executionId,
    providerTurnId: parse(ProviderTurnId)(
      `ptn_018f2b3c-4d5e-7abc-8def-${String(call.invocationId).slice(-12)}`,
    ),
    logicalStepNo: 0,
    repairAttempt: 0,
    logicalActionId: `action:${String(call.invocationId)}`,
    actionIndex: 0,
    callRef: call.callRef,
  },
  recoveryBindingPolicyRevisions: {
    workspacePolicyRevision: 0,
    projectPolicyRevision: 0,
  },
  authority: {
    principal: owner.principal,
    workspaceId: owner.workspaceId,
    executionId: owner.executionId,
    toolName: call.toolName,
    toolVersion: call.toolVersion,
    sourceRevision: invocationAuthoritySourceRevisionOf({
      workspacePolicyRevision: 0,
      activeGrants: [],
      verifierId: null,
    }),
    resourceSpaceIds: ["filesystem"],
    allowedCapabilities: ["fs:read", "fs:write"],
    controlBasisDigest: "f".repeat(64),
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
});
const invoke = (owner: typeof a, call: ToolIntent, app = makeApp()) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        const boundCall = {
          ...call,
          executionId: owner.executionId,
          workspaceId: owner.workspaceId,
        };
        return yield* runtime.invoke(boundCall, context(owner, boundCall));
      }),
      app,
    ),
  );
const recorded = (call: ToolIntent) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        return Option.getOrThrow(
          yield* tx.transact(store.findById(call.invocationId)),
        );
      }),
      makeApp(),
    ),
  );
const output = (result: Awaited<ReturnType<typeof invoke>>) => {
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success")
    throw new Error("expected a successful filesystem result");
  return JSON.parse(result.observation.text);
};

describe.runIf(process.platform === "linux")(
  "filesystem tools through real ownership and durable runtime",
  () => {
    beforeAll(async () => {
      factory = await createCurrentSchemaTestDatabaseFactory({
        prefix: "filesystem-runtime-",
      });
    }, 120_000);
    afterAll(() => factory?.cleanup());
    beforeEach(() => {
      database = factory.create();
    });
    afterEach(() => database?.cleanup());

    it("routes same-path writes and searches to the invoking workspace and stores separate receipts", async () => {
      seed();
      await claim(a, roots[0]);
      await claim(b, roots[1]);
      for (const [index, owner] of [a, b].entries()) {
        const content = index === 0 ? "alpha" : "bravo";
        const call = intent("write", {
          target: target("src/value.txt"),
          content,
        });
        expect(output(await invoke(owner, call))).toMatchObject({
          written: true,
          created: true,
        });
        const receipt = await recorded(call);
        expect(receipt.workspaceId).toBe(owner.workspaceId);
        expect(receipt.executionId).toBe(owner.executionId);
        expect(receipt.resultRef).toMatch(/^art_/u);
        expect(receipt.sideEffectSemantics).toBe("NonIdempotent");
        expect(
          output(
            await invoke(
              owner,
              intent("glob", { target: target(), pattern: "**/*.txt" }),
            ),
          ).matches,
        ).toEqual(["src/value.txt"]);
        expect(
          output(
            await invoke(
              owner,
              intent("grep", { target: target(), query: "alpha|bravo" }),
            ),
          ).matches,
        ).toEqual([
          { path: "src/value.txt", line: 1, column: 1, text: content },
        ]);
      }
      expect(readFileSync(join(roots[0], "src/value.txt"), "utf8")).toBe(
        "alpha",
      );
      expect(readFileSync(join(roots[1], "src/value.txt"), "utf8")).toBe(
        "bravo",
      );
      const outside = await invoke(
        a,
        intent("write", {
          target: target("../b/src/value.txt"),
          content: "wrong",
        }),
      );
      // The bare executor reports an invalid sandbox target as ExpectedFailure,
      // but the complete P4 runtime rejects it earlier as a resource boundary
      // violation. This is the durable cross-workspace isolation outcome.
      expect(outside).toMatchObject({
        _tag: "Denied",
        reasonCode: "ResourceResolutionDenied",
      });
      expect(readFileSync(join(roots[1], "src/value.txt"), "utf8")).toBe(
        "bravo",
      );
    });

    it("does not equate fs:write capability with directory ownership", async () => {
      seed();
      const call = intent("write", {
        target: target("new/value.txt"),
        content: "unauthorized",
      });
      expect((await invoke(a, call))._tag).toBe("Denied");
      expect(existsSync(join(roots[0], "new"))).toBe(false);
      expect((await recorded(call)).effectAdmissionState).toBe("NotAdmitted");
    });

    it("respects a child's exclusive carve-out even when the parent has a broad capability", async () => {
      seed(true);
      await claim(a, roots[0], [roots[1]]);
      await claim(b, roots[1]);
      expect(
        (
          await invoke(
            a,
            intent("write", {
              target: target("child/value.txt"),
              content: "wrong",
            }),
          )
        )._tag,
      ).toBe("Denied");
      expect(existsSync(join(roots[1], "value.txt"))).toBe(false);
      output(
        await invoke(
          b,
          intent("write", { target: target("value.txt"), content: "child" }),
        ),
      );
      // The parent may still write its retained remainder; the child carve-out
      // remains denied because admission uses the exact requested target.
      output(
        await invoke(
          a,
          intent("write", {
            target: target("parent.txt"),
            content: "parent",
          }),
        ),
      );
      writeFileSync(join(roots[0], "parent.txt"), "old\n");
      output(
        await invoke(
          a,
          intent("patch", {
            target: target("parent.txt"),
            unifiedDiff: "@@ -1 +1 @@\n-old\n+parent\n",
          }),
        ),
      );
      expect(readFileSync(join(roots[0], "parent.txt"), "utf8")).toBe(
        "parent\n",
      );
      expect(readFileSync(join(roots[1], "value.txt"), "utf8")).toBe("child");
    });

    it("replays a settled write from durable evidence without replacing a subsequent user edit", async () => {
      seed();
      await claim(a, roots[0]);
      const call = intent("write", {
        target: target("value.txt"),
        content: "agent",
      });
      const trace = { executions: 0 };
      const first = await invoke(a, call, makeApp(trace));
      output(first);
      writeFileSync(join(roots[0], "value.txt"), "user edit");
      const replay = await invoke(a, call, makeApp(trace));
      expect(replay).toEqual(first);
      expect(trace.executions).toBe(1);
      expect(readFileSync(join(roots[0], "value.txt"), "utf8")).toBe(
        "user edit",
      );
    });

    it.each([
      "AH7AfterEffectAdmissionCommit",
      "AH7AfterToolEffectBeforeSettlement",
    ] as const)(
      "does not re-execute an unsettled non-idempotent write after %s",
      async (boundary) => {
        seed();
        await claim(a, roots[0]);
        const call = intent("write", {
          target: target("value.txt"),
          content: "agent",
        });
        const trace = {
          executions: 0,
          probe: async (
            event: Parameters<ToolRuntimeQualificationProbe>[0],
          ) => {
            if (event.boundary === boundary)
              throw new Error("test interruption at durable boundary");
          },
        };
        await expect(invoke(a, call, makeApp(trace))).rejects.toThrow(
          "test interruption",
        );
        const prior = await recorded(call);
        expect(prior.effectAdmissionState).toBe("MayHaveStarted");
        expect(prior.settlement).toBeNull();
        const executions = boundary === "AH7AfterEffectAdmissionCommit" ? 0 : 1;
        expect(trace.executions).toBe(executions);
        expect(existsSync(join(roots[0], "value.txt"))).toBe(executions === 1);
        writeFileSync(
          join(roots[0], "value.txt"),
          "user edit after interruption",
        );
        // Reconstruct the same services against the durable database. The
        // probe is never reached again because recovery cannot re-execute.
        const resumed = await invoke(a, call, makeApp(trace));
        expect(resumed).toEqual({
          _tag: "OutcomeUnknown",
          reconciliationRefs: [String(call.invocationId)],
        });
        expect(trace.executions).toBe(executions);
        expect(readFileSync(join(roots[0], "value.txt"), "utf8")).toBe(
          "user edit after interruption",
        );
        expect((await recorded(call)).settlement?._tag).toBe("OutcomeUnknown");
      },
    );
  },
);
