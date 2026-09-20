import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  InvocationAuthority,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { checkInvocationAuthority } from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");

const definition: ToolDefinition = {
  name: "read",
  version: "1",
  hash: "read-v1",
  description: "read",
  inputSchemaJson: "{}",
  resultSchemaJson: "{}",
  capabilityMetadata: ["fs:read"],
  sideEffectSemantics: "ReadOnly",
  source: "Builtin",
};

const authority: InvocationAuthority = {
  principal,
  workspaceId,
  executionId,
  toolName: "read",
  toolVersion: "1",
  resourceSpaceIds: ["filesystem"],
  allowedCapabilities: ["fs:read"],
  controlBasisDigest: "digest",
  expiresAt: "2999-01-01T00:00:00.000Z",
  delegationDepth: 0,
};

const intent: ToolIntent = {
  callRef: "c1",
  toolName: "read",
  toolVersion: "1",
  argumentsJson: "{}",
  invocationId: parse(ToolInvocationId)(
    "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  approvalId: null,
};

const context: ToolExecutionContext = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority,
  controlBasisDigest: "digest",
  requestedAt: "t",
};

const regions = [{ resourceSpaceId: "filesystem", normalizedRegion: {} }];

const check = (
  overrides: Partial<Parameters<typeof checkInvocationAuthority>[0]> = {},
) =>
  checkInvocationAuthority({
    authority,
    definition,
    intent,
    context,
    regions,
    now: "2026-01-01T00:00:00.000Z",
    maxDelegationDepth: 1,
    ...overrides,
  });

describe("P4 invocation authority", () => {
  it("accepts an exact match", () => {
    expect(check()._tag).toBe("Ok");
  });

  it("denies every mismatch", () => {
    const cases: ReadonlyArray<
      Partial<Parameters<typeof checkInvocationAuthority>[0]>
    > = [
      {
        context: {
          ...context,
          authenticatedPrincipal: parse(Principal)("other"),
        },
      },
      {
        authority: {
          ...authority,
          workspaceId: parse(WorkspaceId)(
            "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
          ),
        },
      },
      { intent: { ...intent, toolVersion: "2" } },
      { authority: { ...authority, controlBasisDigest: "other" } },
      { authority: { ...authority, expiresAt: "2000-01-01T00:00:00.000Z" } },
      { authority: { ...authority, delegationDepth: 5 } },
      { authority: { ...authority, resourceSpaceIds: ["database"] } },
      { authority: { ...authority, allowedCapabilities: [] } },
    ];
    for (const override of cases) {
      const result = check(override);
      expect(result._tag).toBe("Denied");
    }
  });
});
