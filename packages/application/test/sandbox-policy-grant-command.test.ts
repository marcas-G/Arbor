import {
  Actor,
  CommandId,
  ExecutionId,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CommandAuthorityFact } from "../src/authority.js";
import { makeGrantPermissionHandler } from "../src/commands/grant-permission.js";

const operator = parse(Principal)("user:operator");
const subject = parse(Principal)("user:subject");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const grantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const configSnapshot = {
  config: { version: 1 as const, revision: 4, issuers: [operator] },
  configDigest: "a".repeat(64),
  operatorConfigRevision: 9,
  operatorConfigDigest: "f".repeat(64),
  authorityBundleRevision: 4,
  authorityBundleDigest: "b".repeat(64),
  providerRegistryRevision: 3,
  providerRegistryDigest: "c".repeat(64),
  providerRegistry: { version: 1 as const, revision: 3, entries: [] },
};
const now = "2026-10-19T00:00:00.000Z";

const setup = () => {
  const writes: Array<unknown> = [];
  const authority: CommandAuthorityFact = {
    _tag: "GrantPermissionAuthority",
    principal: operator,
    commandId,
    semanticRequestFingerprint: "f".repeat(64) as never,
    projectId,
    permissionGrantId: grantId,
    sandboxPolicyIssuerBinding: {
      executionId,
      operatorConfigRevision: configSnapshot.operatorConfigRevision,
      operatorConfigDigest: configSnapshot.operatorConfigDigest,
      authorityBundleRevision: configSnapshot.authorityBundleRevision,
      authorityBundleDigest: configSnapshot.authorityBundleDigest,
      providerRegistryRevision: configSnapshot.providerRegistryRevision,
      providerRegistryDigest: configSnapshot.providerRegistryDigest,
    },
  };
  const handler = makeGrantPermissionHandler({
    grants: {
      activeGrants: () => Effect.succeed([]),
      findById: () => Effect.succeed(Option.none()),
      findSandboxPolicyGrantIssuerProvenanceByGrantId: () =>
        Effect.succeed(Option.none()),
      insertSandboxPolicyGrantIssuerProvenance: (provenance) =>
        Effect.sync(() =>
          writes.push({ kind: "provenance", value: provenance }),
        ),
      put: (grant) =>
        Effect.sync(() => writes.push({ kind: "grant", value: grant })),
      revoke: () => Effect.void,
    },
    executions: {
      findById: () =>
        Effect.succeed(
          Option.some({
            executionId,
            projectId,
            workspaceId,
            binding: {
              _tag: "WorkspaceExecution" as const,
              workspaceId,
              episode: {
                _tag: "InboxEpisode" as const,
                entryKey: "entry:one",
                inputKind: "HumanMessage",
              },
            },
            sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
            admittedAt: now,
            stopRequestedAt: null,
            state: { status: "Active" as const, settlement: null },
          }),
        ),
    },
    clock: { now: () => Effect.succeed(now) },
    sandboxPolicyGrantIssuerConfigSnapshot: configSnapshot,
  });
  return {
    writes,
    execute: (overrides: Record<string, unknown> = {}) =>
      Effect.runPromise(
        Effect.provideService(
          handler.execute(
            {
              commandType: "GrantPermission",
              commandId,
              projectId,
              actor: parse(Actor)(String(operator)),
              issuedAt: "1999-01-01T00:00:00.000Z",
              resolvedAuthority: authority,
              payload: {
                permissionGrantId: grantId,
                issuer: operator,
                subject: {
                  _tag: "HumanPrincipal" as const,
                  principal: subject,
                },
                capability: "DecideSandboxPolicy",
                target: executionId,
                expiresAt: "2026-10-20T00:00:00.000Z",
                ...overrides,
              },
            },
            { _tag: "External", principal: operator },
          ),
          TransactionScope,
          { session: { id: "sandbox-grant-test" } },
        ),
      ),
  };
};

describe("GrantPermission sandbox issuer provenance", () => {
  it("commits the exact CAPA Grant and provenance and emits the additive event", async () => {
    const state = setup();
    const result = await state.execute();
    expect(result.ok).toBe(true);
    expect(state.writes).toHaveLength(2);
    expect(state.writes[0]).toMatchObject({
      kind: "grant",
      value: {
        permissionGrantId: grantId,
        issuer: operator,
        subject: { _tag: "HumanPrincipal", principal: subject },
        capability: "DecideSandboxPolicy",
        target: executionId,
        validFrom: now,
        revision: 0,
      },
    });
    expect(state.writes[1]).toEqual({
      kind: "provenance",
      value: {
        permissionGrantId: grantId,
        grantPermissionCommandId: commandId,
        issuerPrincipal: operator,
        operatorConfigRevision: configSnapshot.operatorConfigRevision,
        operatorConfigDigest: configSnapshot.operatorConfigDigest,
      },
    });
    if (!result.ok) throw new Error("grant command unexpectedly rejected");
    expect(result.value.events.map(({ eventType }) => eventType)).toEqual([
      "PermissionChanged",
      "SandboxPolicyGrantIssued",
    ]);
    expect(result.value.events[1]?.payload).toEqual({
      permissionGrantId: grantId,
      grantPermissionCommandId: commandId,
      executionId,
      operatorConfigRevision: configSnapshot.operatorConfigRevision,
      operatorConfigDigest: configSnapshot.operatorConfigDigest,
    });
  });

  it("rejects expired or wrong-target grants before any durable write", async () => {
    const expired = setup();
    const expiredResult = await expired.execute({
      expiresAt: "2026-10-18T00:00:00.000Z",
    });
    expect(expiredResult.ok).toBe(false);
    expect(expired.writes).toHaveLength(0);

    const wrongTarget = setup();
    const wrongTargetResult = await wrongTarget.execute({
      target: "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
    });
    expect(wrongTargetResult.ok).toBe(false);
    expect(wrongTarget.writes).toHaveLength(0);
  });
});
