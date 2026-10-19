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
const now = "2026-10-19T00:00:00.000Z";
const configSnapshot = {
  config: { version: 1 as const, revision: 4, operators: [principal] },
  configDigest: "a".repeat(64),
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

const resolve = (value: ReturnType<typeof input>) =>
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
