import {
  Actor,
  CommandId,
  grantPermission,
  makeProjectPolicy,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  type Workspace,
  WorkspaceId,
} from "@arbor/domain";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";
import {
  type AuthorityDecisionInput,
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../src/authority-resolver.js";
import { makeGrantPermissionHandler } from "../src/commands/grant-permission.js";
import {
  decodeCommandPayload,
  decodeCommandPayloadForSchemaVersion,
} from "../src/external-command-codec.js";

const uuid = "018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = parse(WorkspaceId)(`ws_${uuid}`);
const projectId = parse(ProjectId)(`prj_${uuid}`);
const principal = parse(Principal)("user:local");
const payload = {
  permissionGrantId: parse(PermissionGrantId)(`pgr_${uuid}`),
  issuer: principal,
  subject: { _tag: "WorkspaceAgent" as const, workspaceId },
  capability: "fs:write",
  target: workspaceId,
  expiresAt: null,
};
const input = (): AuthorityDecisionInput => ({
  principal,
  submissionContext: { _tag: "External", principal },
  envelope: {
    commandId: parse(CommandId)(`cmd_${uuid}`),
    commandType: "GrantPermission",
    projectId,
    actor: parse(Actor)(String(principal)),
    issuedAt: "2000-01-01T00:00:00Z",
    payload,
  },
  semanticRequestFingerprint: parse(SemanticRequestFingerprint)("a".repeat(64)),
  canonicalFacts: {
    projectId,
    workspace: {
      workspaceId,
      projectId,
      parentWorkspaceId: null,
      lifecycle: "Active",
      revision: 7,
    },
  },
  grants: [],
  governance: { authenticatedHumans: [principal], directParentOf: [] },
  policy: makeProjectPolicy(),
});
const resolve = (value: AuthorityDecisionInput) =>
  Effect.gen(function* () {
    return yield* (yield* AuthorityResolverPort).resolve(value);
  }).pipe(Effect.provide(AuthorityResolverPortLive));

describe("persistent Workspace tool permission", () => {
  it("accepts explicit persistence for concrete Workspace tools and preserves schema-1 finite inputs", () => {
    expect(decodeCommandPayload("GrantPermission", payload).ok).toBe(true);
    expect(
      decodeCommandPayloadForSchemaVersion("GrantPermission", "1", payload).ok,
    ).toBe(false);
    expect(
      decodeCommandPayloadForSchemaVersion("GrantPermission", "1", {
        ...payload,
        expiresAt: "2099-01-01T00:00:00Z",
      }).ok,
    ).toBe(true);
    const result = grantPermission({
      ...payload,
      scope: `fs:write@${workspaceId}`,
      lifetime: "Workspace",
      validFrom: "2026-11-16T00:00:00Z",
      revision: 0,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { expiresAt: null, state: "Active" },
    });
  });

  it.each([
    { subject: { _tag: "HumanPrincipal", principal } },
    { subject: { _tag: "Execution", executionId: `exe_${uuid}` } },
    { target: `ws_${uuid.slice(0, -1)}2` },
    { capability: "*" },
    { capability: "DecideSandboxPolicy" },
    { expiresAt: "" },
    { expiresAt: undefined },
  ])("rejects unbound or implicit persistence %#", (patch) => {
    expect(
      decodeCommandPayload("GrantPermission", { ...payload, ...patch }).ok,
    ).toBe(false);
  });

  it.effect(
    "requires explicit governance membership, current Workspace and exact scope",
    () =>
      Effect.gen(function* () {
        const authority = yield* resolve(input());
        expect(authority).toMatchObject({
          _tag: "GrantPermissionAuthority",
          workspacePermissionBinding: { workspaceId, workspaceRevision: 7 },
        });
        const original = input();
        const workspace = original.canonicalFacts.workspace;
        if (workspace === undefined) throw new Error("test Workspace missing");
        for (const changed of [
          {
            ...original,
            governance: { authenticatedHumans: [], directParentOf: [] },
          },
          { ...original, canonicalFacts: { projectId } },
          {
            ...original,
            canonicalFacts: {
              projectId,
              workspace: { ...workspace, lifecycle: "Retired" as const },
            },
          },
          {
            ...original,
            canonicalFacts: {
              projectId,
              workspace: {
                ...workspace,
                projectId: parse(ProjectId)(`prj_${uuid.slice(0, -1)}2`),
              },
            },
          },
          {
            ...original,
            envelope: {
              ...original.envelope,
              payload: { ...payload, target: `ws_${uuid.slice(0, -1)}2` },
            },
          },
        ])
          expect(yield* Effect.flip(resolve(changed))).toMatchObject({
            _tag: "NoApplicableGrant",
          });
      }),
  );

  it.effect(
    "rereads Workspace inside the transaction, uses trusted time and writes no grant after a stale authority",
    () =>
      Effect.gen(function* () {
        const request = input();
        const authority = yield* resolve(request);
        const now = "2026-11-16T00:00:00Z";
        let revision = 7;
        const writes: unknown[] = [];
        const handler = makeGrantPermissionHandler({
          clock: { now: () => Effect.succeed(now) },
          workspaces: {
            findById: () =>
              Effect.succeed(
                Option.some({
                  workspaceId,
                  projectId,
                  lifecycle: "Active",
                  revision,
                } as Workspace),
              ),
          },
          grants: {
            put: (grant: unknown) =>
              Effect.sync(() => {
                writes.push(grant);
              }),
          } as never,
        });
        const execute = () =>
          handler.execute(
            {
              ...request.envelope,
              payload,
              resolvedAuthority: authority,
            },
            request.submissionContext,
          ) as Effect.Effect<unknown>;
        revision = 8;
        expect(yield* execute()).toMatchObject({
          ok: false,
          error: { _tag: "AuthorityDenied" },
        });
        expect(writes).toHaveLength(0);
        revision = 7;
        expect(yield* execute()).toMatchObject({
          ok: true,
          value: {
            events: [{ eventType: "PermissionChanged", occurredAt: now }],
          },
        });
        expect(writes).toEqual([
          expect.objectContaining({
            subject: payload.subject,
            target: workspaceId,
            validFrom: now,
            expiresAt: null,
            lifetime: "Workspace",
          }),
        ]);
      }),
  );
});
