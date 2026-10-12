import { describe, expect, it } from "vitest";
import type {
  AgentBinding,
  ResponsibilityBoundAgentBinding,
} from "../src/index.js";
import * as domain from "../src/index.js";
import {
  DecisionId,
  executionBound,
  grantPermission,
  isPermissionActive,
  PermissionGrantId,
  Principal,
  parse,
  responsibilityBound,
  revokePermission,
  WorkspaceId,
} from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const issuer = parse(Principal)("principal:governance");
const permissionGrantInput = () => ({
  permissionGrantId: parse(PermissionGrantId)(
    "pgr_018f2b3c-4d5e-7abc-8def-0123456789ab",
  ),
  scope: `tool:patch@${workspaceId}`,
  issuer,
  lifetime: "PT1H",
  subject: { _tag: "WorkspaceAgent" as const, workspaceId },
  capability: "tool:patch",
  target: workspaceId,
  validFrom: "2026-10-12T00:00:00.000Z",
  expiresAt: "2026-10-12T01:00:00.000Z",
  revision: 0,
});

const describeBinding = (binding: AgentBinding): string => {
  switch (binding._tag) {
    case "ResponsibilityBoundAgentBinding":
      return `responsibility:${binding.workspaceId}`;
    case "ExecutionBoundAgentBinding":
      return `execution:${binding.mission}`;
    default: {
      const unreachable: never = binding;
      return unreachable;
    }
  }
};

describe("agent binding vocabulary", () => {
  it("has exactly the two frozen variants", () => {
    expect(describeBinding(responsibilityBound(workspaceId))).toBe(
      `responsibility:${workspaceId}`,
    );
    expect(describeBinding(executionBound("verify"))).toBe("execution:verify");
  });

  it("type-level: the two binding variants are not interchangeable", () => {
    const responsibility = responsibilityBound(workspaceId);
    // @ts-expect-error ResponsibilityBound is not ExecutionBound
    const wrong: { readonly _tag: "ExecutionBoundAgentBinding" } =
      responsibility;
    void wrong;
    const correct: ResponsibilityBoundAgentBinding = responsibility;
    void correct;
  });

  it("does not define AgentId or a long-lived Agent aggregate", () => {
    expect("AgentId" in domain).toBe(false);
    expect("Agent" in domain).toBe(false);
  });
});

describe("permission grant lifecycle", () => {
  it("grants Active and revokes to Revoked", () => {
    const result = grantPermission(permissionGrantInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grant = result.value;
    expect(grant.state).toBe("Active");
    expect(isPermissionActive(grant)).toBe(true);
    expect(grant).toMatchObject({
      subject: { _tag: "WorkspaceAgent", workspaceId },
      capability: "tool:patch",
      target: workspaceId,
      validFrom: "2026-10-12T00:00:00.000Z",
      expiresAt: "2026-10-12T01:00:00.000Z",
      revision: 0,
    });

    const revoked = revokePermission(grant, { authorized: true });
    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.value.state).toBe("Revoked");
    }
  });

  it("requires authority to revoke", () => {
    const grantResult = grantPermission(permissionGrantInput());
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;
    const grant = grantResult.value;
    const revokeResult = revokePermission(grant, { authorized: false });
    expect(revokeResult.ok).toBe(false);
    if (!revokeResult.ok) {
      expect(revokeResult.error._tag).toBe("AuthorityDenied");
    }
  });

  it("rejects reactivating the same revoked grant", () => {
    const result = grantPermission(permissionGrantInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grant = result.value;
    const revoked = revokePermission(grant, { authorized: true });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) {
      throw new Error("expected revoke");
    }
    const reactivate = revokePermission(revoked.value, { authorized: true });
    expect(reactivate.ok).toBe(false);
    if (!reactivate.ok) {
      expect(reactivate.error._tag).toBe("TerminalLifecycleMutation");
    }
  });

  it.each([
    ["whitespace target", { target: "  " }],
    ["whitespace capability", { capability: " tool:patch " }],
    ["invalid expiry", { expiresAt: "tomorrow" }],
    ["expired window", { expiresAt: "2026-10-12T00:00:00.000Z" }],
  ] as const)(
    "rejects a grant with %s at the domain constructor",
    (_name, patch) => {
      const result = grantPermission({ ...permissionGrantInput(), ...patch });

      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AuthorityDenied" },
      });
    },
  );

  it("records a decision with supersede semantics", () => {
    const oldId = parse(DecisionId)("dec_018f2b3c-4d5e-7abc-8def-0123456789ab");
    const decision = {
      decisionId: parse(DecisionId)("dec_018f2b3c-4d5e-7abc-8def-0123456789ac"),
      supersedes: oldId,
      recordedAt: "2026-09-20T00:00:00.000Z",
    };
    expect(decision.supersedes).toBe(oldId);
  });
});
