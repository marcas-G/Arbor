import {
  Actor,
  CommandId,
  ExecutionId,
  makeProjectPolicy,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  WorkspaceId,
} from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AuthorityDecisionInput,
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../src/authority-resolver.js";

const principal = parse(Principal)("user:operator");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const permissionGrantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const decisionCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const subjectPrincipal = parse(Principal)("user:subject");
const now = "2026-10-19T00:00:00.000Z";
const configSnapshot = {
  config: { version: 1 as const, revision: 4, issuers: [principal] },
  configDigest: "a".repeat(64),
  authorityBundleRevision: 4,
  authorityBundleDigest: "b".repeat(64),
  providerRegistryRevision: 3,
  providerRegistryDigest: "c".repeat(64),
  providerRegistry: { version: 1 as const, revision: 3, entries: [] },
};

const input = (overrides: Record<string, unknown> = {}) => {
  const payload = {
    permissionGrantId,
    issuer: principal,
    subject: { _tag: "HumanPrincipal", principal: "user:subject" },
    capability: "DecideSandboxPolicy",
    target: executionId,
    expiresAt: "2026-10-20T00:00:00.000Z",
  };
  return {
    principal,
    submissionContext: { _tag: "External" as const, principal },
    envelope: {
      commandType: "GrantPermission",
      commandId,
      projectId,
      actor: parse(Actor)(String(principal)),
      issuedAt: "1999-01-01T00:00:00.000Z",
      payload: { ...payload, ...overrides },
    },
    semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
      "f".repeat(64),
    ),
    canonicalFacts: {
      projectId,
      execution: {
        executionId,
        projectId,
        workspaceId,
        status: "Active" as const,
      },
    },
    grants: [],
    governance: { authenticatedHumans: [], directParentOf: [] },
    policy: makeProjectPolicy({}),
    sandboxPolicyGrantIssuerConfigSnapshot: configSnapshot,
    sandboxPolicyAuthorityNow: now,
  } as const;
};

const resolve = (value: AuthorityDecisionInput) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const resolver = yield* AuthorityResolverPort;
        return yield* resolver.resolve(value);
      }),
      AuthorityResolverPortLive,
    ),
  );

describe("P12 sandbox GrantPermission issuer authority", () => {
  it("authorizes only the exact configured human issuer for an active exact Execution", async () => {
    await expect(resolve(input())).resolves.toMatchObject({
      _tag: "GrantPermissionAuthority",
      permissionGrantId,
      sandboxPolicyIssuerBinding: {
        executionId,
        operatorConfigRevision: 4,
        operatorConfigDigest: "a".repeat(64),
        authorityBundleRevision: 4,
        authorityBundleDigest: "b".repeat(64),
        providerRegistryRevision: 3,
        providerRegistryDigest: "c".repeat(64),
      },
    });
  });

  it.each([
    { issuer: "user:other" },
    { subject: { _tag: "HumanPrincipal", principal } },
    { target: "exe_018f2b3c-4d5e-7abc-8def-0123456789a2" },
    { expiresAt: "2026-10-18T00:00:00.000Z" },
  ])(
    "denies invalid issuer, subject, target or lifetime %#",
    async (override) => {
      await expect(resolve(input(override))).rejects.toMatchObject({
        _tag: "NoApplicableGrant",
        commandType: "GrantPermission",
      });
    },
  );

  it("does not let the ordinary human override or a missing config issue the special Grant", async () => {
    const withoutSnapshot = {
      ...input(),
      governance: { authenticatedHumans: [principal], directParentOf: [] },
      sandboxPolicyGrantIssuerConfigSnapshot: undefined,
    } as never;
    await expect(resolve(withoutSnapshot)).rejects.toMatchObject({
      _tag: "NoApplicableGrant",
    });
  });
});

describe("P12 DecideSandboxPolicy CAPA preflight", () => {
  const decisionInput = (overrides: Record<string, unknown> = {}) => {
    const decisionPayload = {
      projectId,
      workspaceId,
      executionId,
      episodeBinding: {
        _tag: "InboxEpisode",
        entryKey: "inbox:one",
        inputKind: "HumanMessage",
      },
      expectedEpisodeRevision: 2,
      expectedPolicyRevision: 0,
      expectedWorkspaceRevision: 4,
      expectedResourceBoundaryRevision: 1,
      expectedSandboxHandleBindingDigest: "d".repeat(64),
      expectedAuthorityBundleRevision: 4,
      expectedAuthorityBundleDigest: "b".repeat(64),
      expectedOperatorConfigRevision: 4,
      expectedOperatorConfigDigest: "a".repeat(64),
      expectedProviderRegistryRevision: 3,
      expectedProviderRegistryDigest: "c".repeat(64),
      profile: "ReadOnly",
      providerId: "bwrap",
      networkPolicy: {
        kind: "OsEnforced",
        policy: { version: 1, mode: "Disabled", destinations: [] },
      },
      decisionExpiresAt: "2026-10-19T12:00:00.000Z",
    };
    return {
      ...input(),
      principal: subjectPrincipal,
      submissionContext: {
        _tag: "External" as const,
        principal: subjectPrincipal,
      },
      envelope: {
        commandType: "DecideSandboxPolicy",
        commandId: decisionCommandId,
        projectId,
        actor: parse(Actor)(String(subjectPrincipal)),
        issuedAt: "1999-01-01T00:00:00.000Z",
        payload: { ...decisionPayload, ...overrides },
      },
      canonicalFacts: {
        projectId,
        execution: {
          executionId,
          projectId,
          workspaceId,
          status: "Active" as const,
          episodeRevision: 2,
          episodeBinding: decisionPayload.episodeBinding,
        },
      },
      grants: [
        {
          permissionGrantId,
          scope: "DecideSandboxPolicy@execution",
          issuer: principal,
          lifetime: "Bounded",
          subject: {
            _tag: "HumanPrincipal" as const,
            principal: subjectPrincipal,
          },
          capability: "DecideSandboxPolicy",
          target: executionId,
          validFrom: "2026-10-18T00:00:00.000Z",
          expiresAt: "2026-10-20T00:00:00.000Z",
          revision: 3,
          state: "Active" as const,
        },
      ],
      governance: {
        authenticatedHumans: [subjectPrincipal],
        directParentOf: [],
      },
      sandboxPolicyGrantIssuerProvenance: {
        permissionGrantId,
        grantPermissionCommandId: commandId,
        issuerPrincipal: principal,
        operatorConfigRevision: 4,
        operatorConfigDigest: "a".repeat(64),
      },
    } as AuthorityDecisionInput;
  };

  it("binds the exact active human grant, episode and immutable issuer provenance", async () => {
    await expect(resolve(decisionInput())).resolves.toMatchObject({
      _tag: "SandboxPolicyDecisionAuthority",
      principal: subjectPrincipal,
      workspaceId,
      executionId,
      episodeRevision: 2,
      permissionGrant: { permissionGrantId, revision: 3, state: "Active" },
      issuerProvenance: {
        issuerPrincipal: principal,
        operatorConfigRevision: 4,
      },
    });
  });

  it.each([
    { expectedEpisodeRevision: 1 },
    { executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789a2" },
  ])("denies stale or foreign execution identity %#", async (override) => {
    await expect(resolve(decisionInput(override))).rejects.toMatchObject({
      _tag: "NoApplicableGrant",
      commandType: "DecideSandboxPolicy",
    });
  });
});
