import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  PermissionGrantRepositoryLive,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { validateCommandAuthority } from "../packages/application/src/authority.js";
import {
  type AuthorityDecisionInput,
  AuthorityResolverPort,
  AuthorityResolverPortLive,
  type InvocationDecisionInput,
} from "../packages/application/src/authority-resolver.js";
import {
  type AssignWorkPayload,
  makeAssignWorkHandler,
} from "../packages/application/src/commands/assign-work.js";
import { makeGrantPermissionHandler } from "../packages/application/src/commands/grant-permission.js";
import { makeRevokePermissionHandler } from "../packages/application/src/commands/revoke-permission.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  makeProjectPolicy,
  type PermissionGrant,
  PermissionGrantId,
  type PermissionGrantLifecycle,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  PermissionGrantRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";

/**
 * P12-002 (`02` §1–§6; EC-3 / blocker B4):
 *  - the resolver is a pure/deterministic fact producer declared in
 *    `packages/application` (`R = never`);
 *  - command facts are exact-bound to principal + commandId + fingerprint +
 *    projectId + target; invocation facts bind principal + workspaceId +
 *    executionId + tool + regions + controlBasisDigest (+ actionDigest);
 *  - only the exact `(principal, commandType, commandId, fingerprint)` tuple
 *    yields a fact (no grant / wrong-target grant -> no fact -> AuthorityDenied);
 *  - External Stop resolves to `submissionOrigin: "External"` (TR-8);
 *  - `RegisterProjectToolAuthority` is produced here;
 *  - no path: resolver -> CommandGateway / repository write / approval consume
 *    / tool invoke;
 *  - the `permission_grants` store (migration 12) loads only Active grants; a
 *    revoked grant is absent -> `NoApplicableGrant` (never default-allow);
 *  - `GrantPermission` / `RevokePermission` are the only durable writers (CI-1).
 */

const repoRoot = join(import.meta.dirname, "..");

const HUMAN = parse(Principal)("user:governance");
const AGENT = parse(Principal)("agent:worker");
const OTHER_AGENT = parse(Principal)("agent:other");
const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const WORKSPACE = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1");
const OTHER_WORKSPACE = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const COMMAND = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1");
const OTHER_COMMAND = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const FINGERPRINT = parse(SemanticRequestFingerprint)("fp-authority-resolver");
const OTHER_FINGERPRINT = parse(SemanticRequestFingerprint)(
  "fp-authority-resolver-other",
);
const GRANT = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const ACTOR = parse(Actor)("agent:worker");
const ISSUED_AT = "2026-09-22T00:00:00.000Z";

const makeGrant = (
  scope: string,
  state: PermissionGrantLifecycle = "Active",
): PermissionGrant => ({
  permissionGrantId: GRANT,
  scope,
  issuer: HUMAN,
  lifetime: "PT1H",
  state,
});

const externalContext = (principal: Principal): CommandSubmissionContext => ({
  _tag: "External",
  principal,
});

const decisionInput = (
  overrides: Partial<AuthorityDecisionInput> = {},
): AuthorityDecisionInput => ({
  principal: AGENT,
  submissionContext: externalContext(AGENT),
  envelope: {
    commandType: "AssignWork",
    commandId: COMMAND,
    projectId: PROJECT,
    actor: ACTOR,
    issuedAt: ISSUED_AT,
    payload: { workspaceId: WORKSPACE },
  },
  semanticRequestFingerprint: FINGERPRINT,
  canonicalFacts: {
    projectId: PROJECT,
    workspace: {
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      parentWorkspaceId: null,
    },
  },
  grants: [],
  governance: { authenticatedHumans: [], directParentOf: [] },
  policy: makeProjectPolicy({}),
  ...overrides,
});

const invocationInput = (
  overrides: Partial<InvocationDecisionInput> = {},
): InvocationDecisionInput => ({
  principal: AGENT,
  workspaceId: WORKSPACE,
  executionId: EXECUTION,
  intent: {
    toolName: "read-file",
    toolVersion: "1",
    argumentsJson: JSON.stringify({ path: "a.txt" }),
    actionDigest: "action-digest-1",
    requestedCapabilities: ["fs.read"],
    resolvedRegions: ["filesystem"],
  },
  controlBasisDigest: "control-basis-1",
  grants: [makeGrant("fs.read")],
  governance: { authenticatedHumans: [], directParentOf: [] },
  policy: makeProjectPolicy({ delegationCeiling: 2, authorityTtlSeconds: 600 }),
  delegationDepth: 0,
  now: ISSUED_AT,
  ...overrides,
});

const resolveFact = (input: AuthorityDecisionInput) =>
  Effect.gen(function* () {
    const resolver = yield* AuthorityResolverPort;
    return yield* resolver.resolve(input);
  });

const resolveError = (input: AuthorityDecisionInput) =>
  Effect.flip(resolveFact(input));

const runResolver = <A>(
  program: Effect.Effect<A, unknown, AuthorityResolverPort>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, AuthorityResolverPortLive));

type AppServices = SqlClient | TransactionPort | PermissionGrantRepository;

const makeApp = (): Layer.Layer<AppServices> => {
  const base = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(PermissionGrantRepositoryLive, base),
  ) as Layer.Layer<AppServices>;
};

const run = <A>(program: Effect.Effect<A, unknown, AppServices>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

describe("P12-002 authority resolver production plane", () => {
  it("resolver produces exact-bound facts; no CommandGateway/mutation/approval/tool path", async () => {
    const fact = await runResolver(
      resolveFact(
        decisionInput({ grants: [makeGrant(`AssignWork@${WORKSPACE}`)] }),
      ),
    );
    expect(fact._tag).toBe("AssignWorkAuthority");
    if (fact._tag === "AssignWorkAuthority") {
      expect(fact.principal).toBe(AGENT);
      expect(fact.commandId).toBe(COMMAND);
      expect(fact.semanticRequestFingerprint).toBe(FINGERPRINT);
      expect(fact.projectId).toBe(PROJECT);
      expect(fact.targetWorkspaceId).toBe(WORKSPACE);
    }

    const registerFact = await runResolver(
      resolveFact(
        decisionInput({
          envelope: {
            commandType: "RegisterProjectTool",
            commandId: COMMAND,
            projectId: PROJECT,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: {
              pluginId: "plg_018f2b3c-4d5e-7abc-8def-0123456789a1",
              pluginVersion: "1.0.0",
              contentHash: "hash-v1",
            },
          },
          canonicalFacts: { projectId: PROJECT },
          grants: [makeGrant("RegisterProjectTool")],
        }),
      ),
    );
    expect(registerFact._tag).toBe("RegisterProjectToolAuthority");
    if (registerFact._tag === "RegisterProjectToolAuthority") {
      expect(registerFact.projectId).toBe(PROJECT);
      expect(registerFact.pluginId).toBe(
        "plg_018f2b3c-4d5e-7abc-8def-0123456789a1",
      );
      expect(registerFact.pluginVersion).toBe("1.0.0");
      expect(registerFact.contentHash).toBe("hash-v1");
      expect(registerFact.semanticRequestFingerprint).toBe(FINGERPRINT);
    }

    const invocation = await runResolver(
      Effect.gen(function* () {
        const resolver = yield* AuthorityResolverPort;
        return yield* resolver.resolveInvocation(invocationInput());
      }),
    );
    expect(invocation.principal).toBe(AGENT);
    expect(invocation.workspaceId).toBe(WORKSPACE);
    expect(invocation.executionId).toBe(EXECUTION);
    expect(invocation.toolName).toBe("read-file");
    expect(invocation.toolVersion).toBe("1");
    expect(invocation.resourceSpaceIds).toEqual(["filesystem"]);
    expect(invocation.controlBasisDigest).toBe("control-basis-1");
    expect(invocation.allowedCapabilities).toContain("fs.read");
    expect(invocation.expiresAt).toBe("2026-09-22T00:10:00.000Z");

    const approval = await runResolver(
      Effect.gen(function* () {
        const resolver = yield* AuthorityResolverPort;
        return yield* resolver.resolveApproval(invocationInput());
      }),
    );
    expect(approval.toolName).toBe("read-file");
    expect(approval.toolVersion).toBe("1");
    expect(approval.actionDigest).toBe("action-digest-1");
    expect(approval.targetResourceSpaceIds).toEqual(["filesystem"]);
    expect(approval.controlBasisDigest).toBe("control-basis-1");
    expect(approval.consumedBy).toBeNull();

    const source = readFileSync(
      join(repoRoot, "packages/application/src/authority-resolver.ts"),
      "utf8",
    );
    for (const forbidden of [
      "CommandGateway",
      "consumeApproval",
      "ToolRuntimePort",
      ".invoke(",
      "PermissionGrantRepository",
      ".activeGrants(",
      ".put(",
      ".revoke(",
      ".register(",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("only the exact (principal, commandType, commandId, fingerprint) tuple yields a fact", async () => {
    const noGrant = (await runResolver(
      resolveError(decisionInput({ grants: [] })),
    )) as { _tag: string };
    expect(noGrant._tag).toBe("NoApplicableGrant");

    const wrongTarget = (await runResolver(
      resolveError(
        decisionInput({ grants: [makeGrant(`AssignWork@${OTHER_WORKSPACE}`)] }),
      ),
    )) as { _tag: string };
    expect(wrongTarget._tag).toBe("GrantScopeInsufficient");

    const fact = await runResolver(
      resolveFact(
        decisionInput({ grants: [makeGrant(`AssignWork@${WORKSPACE}`)] }),
      ),
    );
    const rule = makeAssignWorkHandler({} as never).authority;
    const facts = {
      principal: AGENT,
      commandId: COMMAND,
      projectId: PROJECT,
      semanticRequestFingerprint: FINGERPRINT,
      submissionOrigin: "External",
      payload: { workspaceId: WORKSPACE } as unknown as AssignWorkPayload,
    };
    expect(Option.isNone(validateCommandAuthority(fact, rule, facts))).toBe(
      true,
    );

    const denied = (candidate: typeof fact) =>
      validateCommandAuthority(candidate, rule, facts);
    expect(denied({ ...fact, principal: OTHER_AGENT })._tag).toBe("Some");
    expect(denied({ ...fact, commandId: OTHER_COMMAND })._tag).toBe("Some");
    expect(
      denied({ ...fact, semanticRequestFingerprint: OTHER_FINGERPRINT })._tag,
    ).toBe("Some");
    expect(
      Option.getOrThrow(denied({ ...fact, principal: OTHER_AGENT })),
    ).toContain("principal");
  });

  it("External Stop resolves to submissionOrigin External; non-External runtime origin is unsupported", async () => {
    const stopFact = await runResolver(
      resolveFact(
        decisionInput({
          principal: HUMAN,
          submissionContext: externalContext(HUMAN),
          envelope: {
            commandType: "StopExecution",
            commandId: COMMAND,
            projectId: PROJECT,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: { executionId: EXECUTION },
          },
          canonicalFacts: {
            projectId: PROJECT,
            execution: {
              executionId: EXECUTION,
              projectId: PROJECT,
              workspaceId: WORKSPACE,
            },
          },
          governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
        }),
      ),
    );
    expect(stopFact._tag).toBe("StopExecutionAuthority");
    if (stopFact._tag === "StopExecutionAuthority") {
      expect(stopFact.submissionOrigin).toBe("External");
      expect(stopFact.executionId).toBe(EXECUTION);
    }

    const unsupported = (await runResolver(
      resolveError(
        decisionInput({
          submissionContext: {
            _tag: "System",
            principal: AGENT,
            causationRef: "sys-1",
          },
          envelope: {
            commandType: "StopExecution",
            commandId: COMMAND,
            projectId: PROJECT,
            actor: ACTOR,
            issuedAt: ISSUED_AT,
            payload: { executionId: EXECUTION },
          },
        }),
      ),
    )) as { _tag: string };
    expect(unsupported._tag).toBe("UnsupportedOrigin");
  });

  it("a revoked grant is absent from the resolver snapshot -> NoApplicableGrant (never default-allow)", async () => {
    const revoked = (await runResolver(
      resolveError(
        decisionInput({
          grants: [makeGrant(`AssignWork@${WORKSPACE}`, "Revoked")],
        }),
      ),
    )) as { _tag: string };
    expect(revoked._tag).toBe("NoApplicableGrant");
  });

  it("permission_grants migration 12 + repository: only Active grants are loaded; revoke removes the fact", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        expect(Number(version[0]?.user_version)).toBe(13);
        const table = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'permission_grants'",
        );
        expect(table).toHaveLength(1);

        const tx = yield* TransactionPort;
        const grants = yield* PermissionGrantRepository;
        yield* tx.transact(
          grants.put(
            {
              permissionGrantId: GRANT,
              scope: `AssignWork@${WORKSPACE}`,
              issuer: HUMAN,
              lifetime: "PT1H",
              state: "Active",
            },
            PROJECT,
          ),
        );
        const active = yield* tx.transact(grants.activeGrants(PROJECT));
        expect(active).toHaveLength(1);
        expect(active[0]?.state).toBe("Active");

        yield* tx.transact(grants.revoke(GRANT));
        const afterRevoke = yield* tx.transact(grants.activeGrants(PROJECT));
        expect(afterRevoke).toHaveLength(0);

        const noFact = yield* Effect.flip(
          resolveFact(decisionInput({ grants: afterRevoke })).pipe(
            Effect.provide(AuthorityResolverPortLive),
          ),
        );
        expect((noFact as { _tag: string })._tag).toBe("NoApplicableGrant");
      }),
    );
  });

  it("GrantPermission / RevokePermission handlers are the only durable writers (CI-1) and emit PermissionChanged", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const tx = yield* TransactionPort;
        const repo = yield* PermissionGrantRepository;
        const grantHandler = makeGrantPermissionHandler({ grants: repo });
        const revokeHandler = makeRevokePermissionHandler({ grants: repo });
        const context = externalContext(HUMAN);

        const granted = yield* tx.transact(
          grantHandler.execute(
            {
              commandType: "GrantPermission",
              commandId: COMMAND,
              projectId: PROJECT,
              actor: ACTOR,
              issuedAt: ISSUED_AT,
              payload: {
                permissionGrantId: GRANT,
                scope: `AssignWork@${WORKSPACE}`,
                issuer: HUMAN,
                lifetime: "PT1H",
              },
            },
            context,
          ),
        );
        expect(granted.ok).toBe(true);
        if (granted.ok) {
          expect(granted.value.events).toHaveLength(1);
          expect(granted.value.events[0]?.eventType).toBe("PermissionChanged");
        }
        expect((yield* tx.transact(repo.activeGrants(PROJECT))).length).toBe(1);

        const revoked = yield* tx.transact(
          revokeHandler.execute(
            {
              commandType: "RevokePermission",
              commandId: OTHER_COMMAND,
              projectId: PROJECT,
              actor: ACTOR,
              issuedAt: ISSUED_AT,
              payload: { permissionGrantId: GRANT },
            },
            context,
          ),
        );
        expect(revoked.ok).toBe(true);
        expect((yield* tx.transact(repo.activeGrants(PROJECT))).length).toBe(0);

        expect(grantHandler.authority.tag).toBe("GrantPermissionAuthority");
        expect(revokeHandler.authority.tag).toBe("RevokePermissionAuthority");
      }),
    );
  });
});
