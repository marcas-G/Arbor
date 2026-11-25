import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "@arbor/application";
import {
  CommandId,
  type Execution,
  ExecutionId,
  encodeSandboxEnforcementRuleSetV2,
  Principal,
  ProjectId,
  parse,
  produceSandboxBoundaryV1,
  type SandboxPolicyDecision,
  type SandboxPolicyDecisionCommittedInternal,
  SessionId,
  sandboxEnforcementRuleSetV2ForProvider,
  type Workspace,
  WorkspaceId,
  type WorkspaceSandboxAuthorization,
} from "@arbor/domain";
import { IdGeneratorLive } from "@arbor/persistence-sqlite";
import {
  type CurrentSandboxAuthoritySnapshotV2Result,
  IdGenerator,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  makeWorkspaceSandboxPolicyBindingService,
  type WorkspaceSandboxPolicyBindingDependencies,
} from "../src/workspace-sandbox-policy-binding.js";

const id = "018f2b3c-4d5e-7abc-8def-0123456789a1";
const projectId = parse(ProjectId)(`prj_${id}`);
const workspaceId = parse(WorkspaceId)(`ws_${id}`);
const executionId = parse(ExecutionId)(`exe_${id}`);
const now = "2026-11-16T00:00:00.000Z";
const episode = {
  _tag: "InboxEpisode",
  entryKey: "binding:test",
  inputKind: "HumanMessage",
} as const;
const region = {
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path: "/project" },
};

// These are orchestration fixtures. Gateway persistence and host preparation
// have separate SQLite integration qualification; no native execution is faked.
const fixture = async () => {
  const workspace = {
    projectId,
    workspaceId,
    parentWorkspaceId: null,
    lifecycle: "Active",
    revision: 0,
    resourceBoundaryRevision: 0,
    responsibilityRevision: 0,
    workspacePolicyRevision: 0,
    resourceBoundary: {
      basisResponsibilityRevision: 0,
      addresses: [{ _tag: "FileTree", path: "/project" }],
    },
  } as unknown as Workspace;
  const execution: Execution = {
    projectId,
    workspaceId,
    executionId,
    sessionId: parse(SessionId)(`ses_${id}`),
    admittedAt: now,
    binding: { _tag: "WorkspaceExecution", workspaceId, episode },
    stopRequestedAt: null,
    state: { status: "Active", settlement: null },
  };
  const authorization: WorkspaceSandboxAuthorization = {
    version: 1,
    projectId,
    workspaceId,
    authorizationRevision: 1,
    commandId: parse(CommandId)(`cmd_${id}`),
    actorPrincipal: parse(Principal)("user:local"),
    recordedAt: now,
    state: "Granted",
    origin: { kind: "Human", principal: parse(Principal)("user:local") },
    resourceBoundaryRevision: 0,
    workspacePolicyRevision: 0,
    profile: "ReadOnly",
    providerId: "linux-bwrap",
    networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
    expiresAt: null,
  };
  const ruleSet = sandboxEnforcementRuleSetV2ForProvider("linux-bwrap");
  if (ruleSet === undefined) throw new Error("Linux rule set missing");
  const host = {
    _tag: "Available",
    currentHost: { osFamily: "Linux", osBuild: "linux" },
    snapshot: {
      bundleDigest: "a".repeat(64),
      bundle: {
        bundleRevision: 1,
        operatorConfigRevision: 1,
        operatorConfigDigest: "b".repeat(64),
        providerRegistryRevision: 1,
        providerRegistryDigest: "c".repeat(64),
        providerRegistry: {
          entries: [
            {
              status: "Supported",
              providerId: "linux-bwrap",
              providerVersion: "1",
              capabilityRevision: 1,
              osFamily: "Linux",
              osBuild: "linux",
              qualificationEvidenceRef: `blob:sha256:${"d".repeat(64)}`,
              tuple: {
                profile: "ReadOnly",
                networkMode: "Enabled",
                networkPolicyCodecVersion: 1,
                enforcementRuleSetDigest: sha256Hex(
                  encodeSandboxEnforcementRuleSetV2(ruleSet),
                ),
              },
            },
          ],
        },
      },
    },
  } as unknown as CurrentSandboxAuthoritySnapshotV2Result;
  const gateway = {
    execute: vi.fn().mockImplementation(() =>
      Effect.succeed({
        resolution: { _tag: "Committed", result: { policyRevision: 1 } },
      }),
    ),
  };
  const findAuthorization = vi.fn<
    WorkspaceSandboxPolicyBindingDependencies["authorizations"]["findCurrent"]
  >(() => Effect.succeed(Option.some(authorization)));
  const findExecution = vi.fn(() => Effect.succeed(Option.some(execution)));
  const loadHost = vi.fn(() => Effect.succeed(host));
  const findWorkspace = vi.fn(() => Effect.succeed(Option.some(workspace)));
  const dependencies: WorkspaceSandboxPolicyBindingDependencies = {
    transaction: {
      transact: (effect) => effect,
    } as WorkspaceSandboxPolicyBindingDependencies["transaction"],
    workspaces: { findById: findWorkspace },
    executions: {
      findById: findExecution,
      findEpisodeRevision: () => Effect.succeed(Option.some(0)),
    },
    authorizations: { findCurrent: findAuthorization },
    decisions: { findCurrentForExecution: () => Effect.succeed(Option.none()) },
    unavailable: {
      findByExecutionAndRevision: () => Effect.succeed(undefined),
    },
    boundary: {
      readCurrentForWorkspace: () =>
        Effect.succeed({
          workspace,
          ownershipClaims: [],
          worktrees: [],
          resolvedRegions: [region],
          primaryResourceRegion: region,
        }),
    },
    currentHost: { loadCurrentVerifiedV2: loadHost },
    gateway,
    resolver: await Effect.runPromise(
      Effect.provide(AuthorityResolverPort, AuthorityResolverPortLive),
    ),
    clock: { now: () => Effect.succeed(now) },
    ids: {
      generate: () => Effect.succeed(parse(CommandId)(`cmd_${id}`)),
    } as WorkspaceSandboxPolicyBindingDependencies["ids"],
  };
  const run = () =>
    Effect.runPromise(
      makeWorkspaceSandboxPolicyBindingService(dependencies).ensureForExecution(
        executionId,
      ),
    );
  return {
    run,
    dependencies,
    workspace,
    execution,
    authorization,
    gateway,
    findAuthorization,
    findExecution,
    findWorkspace,
    loadHost,
  };
};

describe("automatic Workspace execution policy binding", () => {
  it("binds with a canonical CommandId when the production generator returns a raw UUID", async () => {
    const f = await fixture();
    const ids = await Effect.runPromise(
      Effect.provide(IdGenerator, IdGeneratorLive),
    );
    const service = makeWorkspaceSandboxPolicyBindingService({
      ...f.dependencies,
      ids,
    });
    expect(
      await Effect.runPromise(service.ensureForExecution(executionId)),
    ).toEqual({
      _tag: "Ready",
      policyRevision: 1,
    });
    const commandId = f.gateway.execute.mock.calls[0]?.[0].commandId;
    expect(parse(CommandId)(commandId)).toBe(commandId);
  });

  it("renews an otherwise current policy after that revision recorded provider unavailability", async () => {
    const f = await fixture();
    await f.run();
    const envelope = f.gateway.execute.mock.calls[0]?.[0];
    if (envelope === undefined) throw new Error("Initial binding missing");
    const p = envelope.payload;
    const host = await Effect.runPromise(
      f.dependencies.currentHost.loadCurrentVerifiedV2(),
    );
    if (host._tag !== "Available") throw new Error("Host unavailable");
    const boundary = await Effect.runPromise(
      f.dependencies.transaction.transact(
        f.dependencies.boundary.readCurrentForWorkspace({
          projectId,
          workspaceId,
        }),
      ),
    );
    const produced = produceSandboxBoundaryV1(
      {
        workspaceId,
        resourceBoundaryRevision: 0,
        responsibilityRevision: 0,
        boundary: boundary.workspace.resourceBoundary,
        resolvedRegions: boundary.resolvedRegions,
        primaryResourceRegion: boundary.primaryResourceRegion,
        ownershipClaims: boundary.ownershipClaims,
        policyKind: "OsEnforced",
        profile: "ReadOnly",
      },
      sha256Hex,
    );
    if (produced === undefined) throw new Error("Boundary unavailable");
    // Only binder-read fields are supplied by this orchestration fixture.
    // Canonical complete receipts have separate Gateway/SQLite qualification.
    const current = {
      decision: {
        authorityKind: "WorkspaceAuthorization",
        projectId,
        workspaceId,
        executionId,
        workspaceAuthorizationRevision: 1,
        decisionCommandId: envelope.commandId,
        issuedAt: now,
        expiresAt: p.decisionExpiresAt,
        profile: p.profile,
        providerId: p.providerId,
        networkPolicy: p.networkPolicy,
        policyRevision: 1,
        episodeBinding: episode,
        expectedExecutionRevision: 0,
      },
      result: {
        version: 3,
        projectId,
        workspaceId,
        executionId,
        commandId: envelope.commandId,
        workspaceAuthorizationRevision: 1,
        effectivePolicySnapshot: {
          version: 2,
          policyRevision: 1,
          workspaceRevision: 0,
          resourceBoundaryRevision: 0,
          resourceBoundaryDigest: produced.resourceBoundaryDigest,
          sandboxHandleBindingDigest: produced.sandboxHandleBindingDigest,
          authorityBundleRevision: p.expectedAuthorityBundleRevision,
          authorityBundleDigest: p.expectedAuthorityBundleDigest,
          operatorConfigRevision: p.expectedOperatorConfigRevision,
          operatorConfigDigest: p.expectedOperatorConfigDigest,
          providerRegistryRevision: p.expectedProviderRegistryRevision,
          providerRegistryDigest: p.expectedProviderRegistryDigest,
          providerVersion: p.providerVersion,
          capabilityRevision: p.capabilityRevision,
          osBuild: host.currentHost.osBuild,
          qualificationEvidenceRef:
            host.snapshot.bundle.providerRegistry.entries[0]
              ?.qualificationEvidenceRef,
        },
      },
    } as unknown as {
      decision: SandboxPolicyDecision;
      result: SandboxPolicyDecisionCommittedInternal;
    };
    vi.spyOn(
      f.dependencies.decisions,
      "findCurrentForExecution",
    ).mockReturnValue(Effect.succeed(Option.some(current)));
    f.gateway.execute.mockClear();
    expect(await f.run()).toEqual({ _tag: "Ready", policyRevision: 1 });
    expect(f.gateway.execute).not.toHaveBeenCalled();
    vi.spyOn(
      f.dependencies.unavailable,
      "findByExecutionAndRevision",
    ).mockReturnValue(
      Effect.succeed({ executionId, policyRevision: 1 } as never),
    );
    f.gateway.execute.mockImplementation(() =>
      Effect.succeed({
        resolution: { _tag: "Committed", result: { policyRevision: 2 } },
      }),
    );
    expect(await f.run()).toEqual({ _tag: "Ready", policyRevision: 2 });
    expect(f.gateway.execute).toHaveBeenCalledOnce();
    expect(
      f.gateway.execute.mock.calls[0]?.[0].payload.expectedPolicyRevision,
    ).toBe(1);
  });

  it("submits one exact internal policy with a finite lifetime, without a human grant", async () => {
    const f = await fixture();
    expect(await f.run()).toEqual({ _tag: "Ready", policyRevision: 1 });
    expect(f.gateway.execute).toHaveBeenCalledOnce();
    const call = f.gateway.execute.mock.calls[0];
    if (call === undefined) throw new Error("Expected policy submission");
    const [envelope, context, authority] = call;
    expect(context._tag).toBe("System");
    expect(authority._tag).toBe("WorkspaceSandboxPolicyBindingAuthority");
    expect(envelope.payload).toMatchObject({
      workspaceId,
      executionId,
      episodeBinding: episode,
      expectedAuthorizationRevision: 1,
      expectedPolicyRevision: 0,
      profile: "ReadOnly",
      providerId: "linux-bwrap",
      decisionExpiresAt: "2026-11-16T01:00:00.000Z",
    });
    expect(envelope.payload).not.toHaveProperty("permissionGrantId");
  });

  it("bounds the policy by the standing authorization expiry", async () => {
    const f = await fixture();
    f.findAuthorization.mockReturnValue(
      Effect.succeed(
        Option.some({
          ...f.authorization,
          expiresAt: "2026-11-16T00:10:00.000Z",
        } as WorkspaceSandboxAuthorization),
      ),
    );
    expect((await f.run())._tag).toBe("Ready");
    expect(f.gateway.execute.mock.calls[0]?.[0].payload.decisionExpiresAt).toBe(
      "2026-11-16T00:10:00.000Z",
    );
  });

  it.each([
    "missing",
    "revoked",
    "expired",
    "boundary changed",
    "workspace policy changed",
  ])("does not bind when authority is %s", async (reason) => {
    const f = await fixture();
    if (reason === "missing")
      f.findAuthorization.mockReturnValue(Effect.succeed(Option.none()));
    if (reason === "revoked")
      f.findAuthorization.mockReturnValue(
        Effect.succeed(
          Option.some({
            ...f.authorization,
            state: "Revoked",
            authorizationRevision: 2,
          } as WorkspaceSandboxAuthorization),
        ),
      );
    if (reason === "expired")
      f.findAuthorization.mockReturnValue(
        Effect.succeed(
          Option.some({
            ...f.authorization,
            expiresAt: now,
          } as WorkspaceSandboxAuthorization),
        ),
      );
    if (reason === "boundary changed")
      f.findWorkspace.mockImplementation(() =>
        Effect.succeed(
          Option.some({
            ...f.workspace,
            resourceBoundaryRevision: 1,
          } as Workspace),
        ),
      );
    if (reason === "workspace policy changed")
      f.findWorkspace.mockImplementation(() =>
        Effect.succeed(
          Option.some({
            ...f.workspace,
            workspacePolicyRevision: 1,
          } as Workspace),
        ),
      );
    expect(await f.run()).toEqual({ _tag: "AuthorizationRequired" });
    expect(f.gateway.execute).not.toHaveBeenCalled();
  });

  it("does not bind a stopping execution", async () => {
    const f = await fixture();
    f.findExecution.mockReturnValue(
      Effect.succeed(Option.some({ ...f.execution, stopRequestedAt: now })),
    );
    expect(await f.run()).toEqual({ _tag: "NotApplicable" });
    expect(f.gateway.execute).not.toHaveBeenCalled();
  });

  it("does not bind with an unavailable host", async () => {
    const f = await fixture();
    f.loadHost.mockReturnValue(
      Effect.succeed({
        _tag: "Unavailable",
        failure: "CurrentHostIdentityUnavailable",
      }),
    );
    expect(await f.run()).toEqual({ _tag: "Unavailable" });
    expect(f.gateway.execute).not.toHaveBeenCalled();
  });

  it("retries a stale snapshot once and never loops indefinitely", async () => {
    const f = await fixture();
    f.gateway.execute.mockImplementation(() =>
      Effect.succeed({
        resolution: {
          _tag: "TerminalRejected",
          error: { _tag: "StaleSandboxPolicyInputs" },
        },
      }),
    );
    expect(await f.run()).toEqual({ _tag: "Stale" });
    expect(f.gateway.execute).toHaveBeenCalledTimes(2);
  });
});
