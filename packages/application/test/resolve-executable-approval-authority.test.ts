import { makeProjectPolicy } from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AuthorityDecisionInput,
  AuthorityResolverPort,
  AuthorityResolverPortLive,
  type ParentUserGovernanceFacts,
} from "../src/authority-resolver.js";

const principal = "workspace-agent:parent" as never;
const foreignParent = "workspace-agent:other-parent" as never;
const projectId = "prj_018ee90a-5b83-7def-8c2d-7ef1a3c5a001" as never;
const workspaceId = "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a002" as never;
const foreignWorkspaceId = "ws_018ee90a-5b83-7def-8c2d-7ef1a3c5a003" as never;
const executionId = "exe_018ee90a-5b83-7def-8c2d-7ef1a3c5a004" as never;
const approvalId = "eap_p38_direct_parent";
const commandId = "cmd_018ee90a-5b83-7def-8c2d-7ef1a3c5a005" as never;

const governance = (
  parent: typeof principal | typeof foreignParent,
  target: typeof workspaceId | typeof foreignWorkspaceId = workspaceId,
): ParentUserGovernanceFacts => ({
  authenticatedHumans: [],
  directParentOf: [{ parentPrincipal: parent, workspaceId: target }],
});

const input = (
  parentFacts: ParentUserGovernanceFacts,
  grants: AuthorityDecisionInput["grants"] = [],
): AuthorityDecisionInput => ({
  principal,
  submissionContext: { _tag: "External", principal },
  envelope: {
    commandType: "ResolveExecutableApproval",
    commandId,
    projectId,
    actor: principal,
    issuedAt: "2026-10-16T00:00:00.000Z",
    payload: {
      approvalId,
      expectedRevision: 4,
      decision: "Approve",
      reason: "direct-parent route qualification",
    },
  },
  semanticRequestFingerprint: "fingerprint-p38-direct-parent" as never,
  canonicalFacts: {
    projectId,
    execution: {
      executionId,
      projectId,
      workspaceId,
      status: "Active",
    },
    executableApproval: {
      approvalId,
      projectId,
      workspaceId,
      executionId,
      state: "Pending",
      revision: 4,
    },
  },
  grants,
  governance: parentFacts,
  policy: makeProjectPolicy(),
});

const resolve = (decision: AuthorityDecisionInput) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const resolver = yield* AuthorityResolverPort;
        return yield* Effect.match(resolver.resolve(decision), {
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        });
      }),
      AuthorityResolverPortLive,
    ),
  );

describe("ResolveExecutableApproval direct-parent authority", () => {
  it("allows only the exact direct parent of the canonical approval workspace", async () => {
    const result = await resolve(input(governance(principal)));
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toMatchObject({
        _tag: "ExecutableApprovalDecisionAuthority",
        principal,
        commandId,
        projectId,
        approvalId,
        workspaceId,
        executionId,
        expectedRevision: 4,
      });
    }
  });

  it.each([
    ["wrong parent", governance(foreignParent)],
    ["foreign workspace edge", governance(principal, foreignWorkspaceId)],
  ])("denies %s", async (_case, parentFacts) => {
    const result = await resolve(input(parentFacts));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "NoApplicableGrant",
        principal,
        commandType: "ResolveExecutableApproval",
        commandId,
      });
    }
  });

  it.each([
    {
      name: "revoked grant",
      grant: {
        permissionGrantId: "pgr_018ee90a-5b83-7def-8c2d-7ef1a3c5a006",
        scope: `ResolveExecutableApproval@${workspaceId}`,
        issuer: principal,
        lifetime: "test-only",
        capability: "ResolveExecutableApproval",
        target: workspaceId,
        state: "Revoked",
      },
    },
    {
      name: "expired grant",
      grant: {
        permissionGrantId: "pgr_018ee90a-5b83-7def-8c2d-7ef1a3c5a007",
        scope: `ResolveExecutableApproval@${workspaceId}`,
        issuer: principal,
        lifetime: "test-only",
        capability: "ResolveExecutableApproval",
        target: workspaceId,
        validFrom: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
        state: "Active",
      },
    },
  ])(
    "does not let a $name substitute for a direct-parent edge",
    async ({ grant }) => {
      const result = await resolve(
        input({ authenticatedHumans: [], directParentOf: [] }, [
          grant as never,
        ]),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "NoApplicableGrant",
          commandType: "ResolveExecutableApproval",
          commandId,
        });
      }
    },
  );
});
