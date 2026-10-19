import { createHash } from "node:crypto";
import type { PermissionGrant } from "@arbor/domain";
import {
  Actor,
  CommandId,
  ExecutionId,
  encodeNetworkPolicyV1,
  networkBrokerControlsV1ForMode,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CommandAuthorityFact } from "../src/authority.js";
import {
  type DecideSandboxPolicyPayload,
  makeDecideSandboxPolicyHandler,
} from "../src/commands/decide-sandbox-policy.js";

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
        version: 1,
        kind: "RegionDigest",
        resourceSpace: "filesystem",
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

const makeHandler = (staleField?: "workspaceRevision") => {
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
    },
    clock: { now: () => Effect.succeed(now) },
  });
  return { handler, inserted };
};

describe("DecideSandboxPolicy command", () => {
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
          snapshot,
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
          snapshot,
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
});
