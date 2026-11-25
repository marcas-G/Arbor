import { createHash } from "node:crypto";
import type { PermissionGrant } from "@arbor/domain";
import {
  Actor,
  CommandId,
  ExecutionId,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV3,
  makeProjectPolicy,
  networkBrokerControlsV1ForMode,
  networkBrokerControlsV2ForMode,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  type Workspace,
  WorkspaceId,
  type WorkspaceSandboxAuthorization,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CommandAuthorityFact } from "../src/authority.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../src/authority-resolver.js";
import { decodeRegisteredCommandReceipt } from "../src/command-result-codec.js";
import {
  type BindWorkspaceSandboxPolicyPayload,
  makeBindWorkspaceSandboxPolicyHandler,
} from "../src/commands/bind-workspace-sandbox-policy.js";
import {
  type DecideSandboxPolicyPayload,
  makeDecideSandboxPolicyHandler,
} from "../src/commands/decide-sandbox-policy.js";
import { semanticRequestFingerprint } from "../src/fingerprint.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const grantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const operator = parse(Principal)("user:operator");
const subject = parse(Principal)("user:subject");
const now = "2026-10-19T00:00:00.000Z";
const episodeBinding = {
  _tag: "InboxEpisode" as const,
  entryKey: "inbox:one",
  inputKind: "HumanMessage",
};
const osNetworkSelection = {
  kind: "OsEnforced" as const,
  policy: { version: 1 as const, mode: "Disabled" as const, destinations: [] },
};
const payload: DecideSandboxPolicyPayload = {
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  expectedEpisodeRevision: 2,
  expectedPolicyRevision: 0,
  expectedWorkspaceRevision: 3,
  expectedResourceBoundaryRevision: 1,
  expectedSandboxHandleBindingDigest: "c".repeat(64),
  expectedAuthorityBundleRevision: 4,
  expectedAuthorityBundleDigest: "e".repeat(64),
  expectedOperatorConfigRevision: 4,
  expectedOperatorConfigDigest: "f".repeat(64),
  expectedProviderRegistryRevision: 3,
  expectedProviderRegistryDigest: "2".repeat(64),
  profile: "ReadOnly",
  providerId: "bwrap",
  providerVersion: "0.8.0",
  capabilityRevision: 1,
  networkPolicy: osNetworkSelection,
  decisionExpiresAt: "2026-10-19T12:00:00.000Z",
};
const grant: PermissionGrant = {
  permissionGrantId: grantId,
  scope: "DecideSandboxPolicy@execution",
  issuer: operator,
  lifetime: "Bounded",
  subject: { _tag: "HumanPrincipal", principal: subject },
  capability: "DecideSandboxPolicy",
  target: executionId,
  validFrom: "2026-10-18T00:00:00.000Z",
  expiresAt: "2026-10-20T00:00:00.000Z",
  revision: 3,
  state: "Active",
};
const provenance = {
  permissionGrantId: grantId,
  grantPermissionCommandId: parse(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
  ),
  issuerPrincipal: operator,
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
};
const authority: Extract<
  CommandAuthorityFact,
  { readonly _tag: "SandboxPolicyDecisionAuthority" }
> = {
  _tag: "SandboxPolicyDecisionAuthority",
  principal: subject,
  commandId,
  semanticRequestFingerprint: parse(SemanticRequestFingerprint)("3".repeat(64)),
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  episodeRevision: 2,
  permissionGrant: grant,
  issuerProvenance: provenance,
  authorityBundleRevision: 4,
  authorityBundleDigest: "e".repeat(64),
  providerRegistryRevision: 3,
  providerRegistryDigest: "2".repeat(64),
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
};
const limits = {
  wallTimeMs: 60_000,
  stdoutBytes: 8192,
  stderrBytes: 8192,
  processCount: 16,
  memoryBytes: 268_435_456,
  cpuTimeMs: 30_000,
};
const snapshot = {
  version: 1 as const,
  kind: "OsEnforced" as const,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  workspaceRevision: 3,
  resourceBoundaryRevision: 1,
  resourceBoundaryDigest: "a".repeat(64),
  sandboxEnvironmentBasisDigest: "b".repeat(64),
  policyRevision: 1,
  expiresAt: payload.decisionExpiresAt,
  profile: "ReadOnly" as const,
  providerId: "bwrap",
  providerVersion: "0.8.0",
  capabilityRevision: 1,
  osFamily: "Linux" as const,
  osBuild: "linux-6.8",
  qualificationEvidenceRef: `blob:sha256:${"1".repeat(64)}`,
  networkPolicy: osNetworkSelection.policy,
  networkPolicyDigest: createHash("sha256")
    .update(encodeNetworkPolicyV1(osNetworkSelection.policy))
    .digest("hex"),
  networkBrokerControls: networkBrokerControlsV1ForMode("Disabled"),
  providerRegistryRevision: 3,
  providerRegistryDigest: "2".repeat(64),
  sandboxHandleBindingDigest: payload.expectedSandboxHandleBindingDigest,
  mounts: [
    {
      mountId: "workspace",
      targetRef: {
        version: 1 as const,
        kind: "RegionDigest" as const,
        resourceSpace: "filesystem" as const,
        regionIdentityDigest: "9".repeat(64),
      },
      targetIdentityDigest: "4".repeat(64),
      access: "ReadOnly" as const,
    },
  ],
  environmentAllowlist: ["PATH"],
  limits,
  auditRefs: ["audit:decision"],
  authorityBundleRevision: 4,
  authorityBundleDigest: "e".repeat(64),
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
};
const current = {
  kind: "OsEnforced" as const,
  expectedEpisodeRevision: 2,
  latestCommittedPolicyRevision: 0,
  episodeBinding,
  workspaceRevision: 3,
  resourceBoundaryRevision: 1,
  sandboxHandleBindingDigest: payload.expectedSandboxHandleBindingDigest,
  authorityBundleRevision: 4,
  authorityBundleDigest: "e".repeat(64),
  operatorConfigRevision: 4,
  operatorConfigDigest: "f".repeat(64),
  providerRegistryRevision: 3,
  providerRegistryDigest: "2".repeat(64),
};
const execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    episode: episodeBinding,
  },
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  admittedAt: now,
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
};

const makeHandler = (
  staleField?: "workspaceRevision",
  sourceStaleField?: "ActionRevision" | "ExecutableApprovalRevision",
) => {
  const inserted: unknown[] = [];
  const handler = makeDecideSandboxPolicyHandler({
    grants: {
      findById: () => Effect.succeed(Option.some(grant)),
      findSandboxPolicyGrantIssuerProvenanceByGrantId: () =>
        Effect.succeed(Option.some(provenance)),
    } as never,
    executions: {
      findById: () => Effect.succeed(Option.some(execution)),
      findEpisodeRevision: () => Effect.succeed(Option.some(2)),
    } as never,
    decisions: {
      findCurrentForExecution: () => Effect.succeed(Option.none()),
      insertCommitted: (value: unknown) =>
        Effect.sync(() => inserted.push(value)),
    } as never,
    preparation: {
      prepare: () => Effect.succeed(snapshot),
      currentPreconditions: () =>
        Effect.succeed(
          staleField === "workspaceRevision"
            ? { ...current, workspaceRevision: 4 }
            : current,
        ),
      preIntentSourceStaleField: () => Effect.succeed(sourceStaleField),
    },
    clock: { now: () => Effect.succeed(now) },
  });
  return { handler, inserted };
};

describe("DecideSandboxPolicy command", () => {
  it("uses schema 2 and allows schema 1 only for prior receipt replay", () => {
    const { handler } = makeHandler();
    expect(handler.schemaVersion).toBe("2");
    expect(handler.priorReceiptSchemaVersions).toEqual(["1"]);
  });

  it("commits a full internal result and minimal event only after exact CAS checks", async () => {
    const { handler, inserted } = makeHandler();
    const result = await Effect.runPromise(
      Effect.provideService(
        handler.execute(
          {
            commandType: "DecideSandboxPolicy",
            commandId,
            projectId,
            actor: parse(Actor)(String(subject)),
            issuedAt: "1999-01-01T00:00:00.000Z",
            payload,
            resolvedAuthority: authority,
          },
          { _tag: "External", principal: subject },
          { _tag: "Ready", summary: snapshot },
        ),
        TransactionScope,
        { session: { id: "sandbox-decision-test" } },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inserted).toHaveLength(1);
    expect(result.value.result).toMatchObject({
      version: 1,
      commandId,
      projectId,
      workspaceId,
      executionId,
      policyRevision: 1,
      effectivePolicySnapshot: {
        kind: "OsEnforced",
        qualificationEvidenceRef: snapshot.qualificationEvidenceRef,
      },
    });
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]?.eventType).toBe(
      "SandboxPolicyDecisionRecorded",
    );
  });

  it("durably rejects stale CAS without a decision insert or event", async () => {
    const { handler, inserted } = makeHandler("workspaceRevision");
    const result = await Effect.runPromise(
      Effect.provideService(
        handler.execute(
          {
            commandType: "DecideSandboxPolicy",
            commandId,
            projectId,
            actor: parse(Actor)(String(subject)),
            issuedAt: now,
            payload,
            resolvedAuthority: authority,
          },
          { _tag: "External", principal: subject },
          { _tag: "Ready", summary: snapshot },
        ),
        TransactionScope,
        { session: { id: "sandbox-decision-test" } },
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "StaleSandboxPolicyInputs",
        safeDetails: { field: "WorkspaceRevision" },
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it.each(["ActionRevision", "ExecutableApprovalRevision"] as const)(
    "returns the safe pre-intent source stale field %s without a decision",
    async (sourceField) => {
      const { handler, inserted } = makeHandler(undefined, sourceField);
      const result = await Effect.runPromise(
        Effect.provideService(
          handler.execute(
            {
              commandType: "DecideSandboxPolicy",
              commandId,
              projectId,
              actor: parse(Actor)(String(subject)),
              issuedAt: now,
              payload,
              resolvedAuthority: authority,
            },
            { _tag: "External", principal: subject },
            { _tag: "Ready", summary: snapshot },
          ),
          TransactionScope,
          { session: { id: "sandbox-decision-test" } },
        ),
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "StaleSandboxPolicyInputs",
          safeDetails: { field: sourceField },
        },
      });
      expect(inserted).toHaveLength(0);
    },
  );
});

describe("Workspace sandbox policy binding", () => {
  const system = parse(Principal)("system:workspace-sandbox-policy");
  const context = {
    _tag: "System" as const,
    principal: system,
    causationRef: `workspace-policy:${executionId}`,
  };
  const request: BindWorkspaceSandboxPolicyPayload = {
    ...payload,
    networkPolicy: osNetworkSelection,
    providerVersion: "0.8.0",
    capabilityRevision: 1,
    profile: "ReadOnly",
    providerId: "linux-bwrap",
    expectedAuthorizationRevision: 1,
  };
  const currentWorkspace = {
    workspaceId,
    projectId,
    parentWorkspaceId: null,
    lifecycle: "Active",
    resourceBoundaryRevision: 1,
    workspacePolicyRevision: 0,
  } as Workspace;
  const authorization: WorkspaceSandboxAuthorization = {
    version: 1,
    state: "Granted",
    projectId,
    workspaceId,
    authorizationRevision: 1,
    commandId: parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a2"),
    actorPrincipal: subject,
    recordedAt: now,
    origin: { kind: "Human", principal: subject },
    resourceBoundaryRevision: 1,
    workspacePolicyRevision: 0,
    profile: "ReadOnly",
    providerId: "linux-bwrap" as never,
    networkPolicy: osNetworkSelection.policy,
    expiresAt: null,
  };
  const host = {
    authorityBundleRevision: 4,
    authorityBundleDigest: "e".repeat(64),
    providerRegistryRevision: 3,
    providerRegistryDigest: "2".repeat(64),
    operatorConfigRevision: 4,
    operatorConfigDigest: "f".repeat(64),
  };
  const bindingAuthority = {
    _tag: "WorkspaceSandboxPolicyBindingAuthority" as const,
    principal: system,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "BindWorkspaceSandboxPolicy",
      projectId,
      actor: parse(Actor)(system),
      schemaVersion: "1",
      payload: request,
    }),
    projectId,
    workspaceId,
    executionId,
    episodeBinding,
    episodeRevision: 2,
    workspaceAuthorizationRevision: 1,
    ...host,
  };
  const envelope = {
    commandType: "BindWorkspaceSandboxPolicy",
    commandId,
    projectId,
    actor: parse(Actor)(system),
    issuedAt: now,
    causationRef: context.causationRef,
    payload: request,
    resolvedAuthority: bindingAuthority,
  };
  const linuxSnapshot = {
    ...snapshot,
    providerId: "linux-bwrap",
    version: 2 as const,
    networkBrokerControls: networkBrokerControlsV2ForMode("Disabled"),
  };
  const harness = (
    options: {
      revoked?: boolean;
      staleHost?: boolean;
      staleExecution?: boolean;
      finiteExpiry?: boolean;
    } = {},
  ) => {
    const inserted: unknown[] = [];
    let head = options.revoked
      ? {
          version: 1 as const,
          state: "Revoked" as const,
          projectId,
          workspaceId,
          authorizationRevision: 2,
          commandId,
          actorPrincipal: subject,
          recordedAt: now,
        }
      : authorization;
    if (options.finiteExpiry)
      head = { ...authorization, expiresAt: "2026-10-19T01:00:00.000Z" };
    const handler = makeBindWorkspaceSandboxPolicyHandler({
      workspaces: {
        findById: () => Effect.succeed(Option.some(currentWorkspace)),
      },
      authorizations: { findCurrent: () => Effect.succeed(Option.some(head)) },
      executions: {
        findById: () =>
          Effect.succeed(
            Option.some(
              options.staleExecution
                ? {
                    ...execution,
                    state: {
                      status: "Settled" as const,
                      settlement: null as never,
                    },
                  }
                : execution,
            ),
          ),
        findEpisodeRevision: () => Effect.succeed(Option.some(2)),
      },
      decisions: {
        findCurrentForExecution: () => Effect.succeed(Option.none()),
        findExact: () => Effect.succeed(Option.none()),
        insertCommitted: (value) =>
          Effect.sync(() => {
            inserted.push(value);
          }),
      },
      preparation: {
        prepare: () => Effect.succeed(linuxSnapshot),
        currentPreconditions: () =>
          Effect.succeed(
            options.staleHost
              ? { ...current, authorityBundleRevision: 5 }
              : current,
          ),
        preIntentSourceStaleField: () => Effect.succeed(undefined),
      },
      clock: { now: () => Effect.succeed(now) },
    });
    return {
      handler,
      inserted,
      revoke: () => {
        head = {
          version: 1,
          state: "Revoked",
          projectId,
          workspaceId,
          authorizationRevision: 2,
          commandId,
          actorPrincipal: subject,
          recordedAt: now,
        };
      },
    };
  };
  const run = <A, E>(effect: Effect.Effect<A, E, TransactionScope>) =>
    Effect.runPromise(
      Effect.provideService(effect, TransactionScope, {
        session: { id: "workspace-policy-test" },
      }),
    );

  it("resolves only exact internal System requests using live Workspace authority", async () => {
    const input = {
      principal: system,
      submissionContext: context,
      envelope,
      semanticRequestFingerprint: bindingAuthority.semanticRequestFingerprint,
      canonicalFacts: {
        projectId,
        workspace: currentWorkspace,
        execution: {
          executionId,
          projectId,
          workspaceId,
          status: "Active" as const,
          episodeRevision: 2,
          episodeBinding,
        },
      },
      grants: [],
      governance: { authenticatedHumans: [subject], directParentOf: [] },
      policy: makeProjectPolicy(),
      workspaceSandboxAuthorizationSnapshot: {
        heads: [authorization],
        workspaces: [currentWorkspace],
      },
      workspaceSandboxAuthorizationNow: now,
      workspaceSandboxPolicyHostSnapshot: host,
    };
    const resolve = (requestInput: typeof input) =>
      Effect.runPromise(
        Effect.provide(
          Effect.flatMap(AuthorityResolverPort, (resolver) =>
            Effect.result(resolver.resolve(requestInput)),
          ),
          AuthorityResolverPortLive,
        ),
      );
    const accepted = await resolve(input);
    expect(accepted._tag).toBe("Success");
    if (accepted._tag === "Success")
      expect(accepted.success).toEqual(bindingAuthority);
    for (const patch of [
      { submissionContext: { _tag: "External", principal: system } },
      { workspaceSandboxPolicyHostSnapshot: undefined },
      {
        workspaceSandboxAuthorizationSnapshot: {
          heads: [],
          workspaces: [currentWorkspace],
        },
      },
      {
        envelope: {
          ...envelope,
          payload: { ...request, expectedAuthorizationRevision: 2 },
        },
      },
    ])
      expect((await resolve({ ...input, ...patch } as typeof input))._tag).toBe(
        "Failure",
      );
  });

  it("commits real Workspace provenance and a V2 event without legacy grant fields", async () => {
    const { handler, inserted } = harness();
    const prepare = handler.prepare;
    if (prepare === undefined)
      throw new Error("binding must preserve its preparation hook");
    const prepared = await Effect.runPromise(
      prepare(envelope, context, bindingAuthority),
    );
    const outcome = await run(handler.execute(envelope, context, prepared));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      authorityKind: "WorkspaceAuthorization",
      workspaceAuthorizationRevision: 1,
      actorPrincipal: system,
    });
    expect(inserted[0]).not.toHaveProperty("permissionGrantId");
    expect(outcome.value.events[0]).toMatchObject({
      eventType: "SandboxPolicyDecisionRecorded",
      eventVersion: 2,
      payload: { workspaceAuthorizationRevision: 1 },
    });
    expect(outcome.value.events[0]?.payload).not.toHaveProperty(
      "permissionGrantId",
    );
    const result = outcome.value.result;
    // Gateway JSON serialization must itself retain exact canonical bytes.
    expect(JSON.stringify(result)).toBe(
      encodeSandboxPolicyDecisionCommittedInternalV3(result),
    );
    const stored = {
      commandId,
      projectId,
      semanticRequestFingerprint: bindingAuthority.semanticRequestFingerprint,
      schemaVersion: "1",
      fingerprintAlgorithmVersion: 1,
      resolution: "Committed" as const,
      resultJson: JSON.stringify(result),
      terminalErrorJson: null,
      createdAt: now,
      settledAt: now,
    };
    expect(
      (
        await Effect.runPromise(
          Effect.result(
            decodeRegisteredCommandReceipt(
              stored,
              "BindWorkspaceSandboxPolicy",
              "1",
            ),
          ),
        )
      )._tag,
    ).toBe("Success");
    expect(
      (
        await Effect.runPromise(
          Effect.result(
            decodeRegisteredCommandReceipt(
              { ...stored, schemaVersion: "2" },
              "DecideSandboxPolicy",
              "2",
            ),
          ),
        )
      )._tag,
    ).toBe("Failure");
  });

  it("rereads revocation after host preparation before writing any decision", async () => {
    const { handler, inserted, revoke } = harness();
    const prepare = handler.prepare;
    if (prepare === undefined)
      throw new Error("binding must preserve its preparation hook");
    const prepared = await Effect.runPromise(
      prepare(envelope, context, bindingAuthority),
    );
    revoke();
    const outcome = await run(handler.execute(envelope, context, prepared));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error._tag).toBe("AuthorityDenied");
    expect(inserted).toEqual([]);
  });

  it.each([
    [{ staleHost: true }, "StaleSandboxPolicyInputs"],
    [{ staleExecution: true }, "StaleSandboxPolicyInputs"],
    [{ finiteExpiry: true }, "DecisionExpiryInvalid"],
  ] as const)(
    "rejects stale or outliving bindings %s",
    async (options, tag) => {
      const { handler, inserted } = harness(options);
      const outcome = await run(
        handler.execute(envelope, context, {
          _tag: "Ready",
          summary: linuxSnapshot,
        }),
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error._tag).toBe(tag);
      expect(inserted).toEqual([]);
    },
  );

  it("cannot enlarge the authorized profile or network selection", async () => {
    const { handler, inserted } = harness();
    for (const patch of [
      { profile: "WorkspaceWrite" as const },
      {
        networkPolicy: {
          kind: "OsEnforced" as const,
          policy: {
            version: 1 as const,
            mode: "Enabled" as const,
            destinations: [],
          },
        },
      },
    ]) {
      const outcome = await run(
        handler.execute(
          { ...envelope, payload: { ...request, ...patch } },
          context,
          { _tag: "Ready", summary: linuxSnapshot },
        ),
      );
      expect(outcome.ok).toBe(false);
    }
    expect(inserted).toEqual([]);
  });
});
