import type { Execution, PermissionGrant } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { permissionGrantMatchesExecution } from "../src/control-authorization.js";

const execution = {
  executionId: "exe_test",
  projectId: "prj_test",
  workspaceId: "ws_test",
} as unknown as Execution;

const grant: PermissionGrant = {
  permissionGrantId: "pgr_test" as never,
  scope: "core.control.assign-work@ws_test",
  issuer: "user:admin" as never,
  lifetime: "until-revoked",
  subject: { _tag: "WorkspaceAgent", workspaceId: "ws_test" as never },
  capability: "core.control.assign-work",
  target: "ws_test",
  validFrom: "2026-10-03T00:00:00.000Z",
  expiresAt: "2026-10-04T00:00:00.000Z",
  revision: 0,
  state: "Active",
};

const matches = (
  candidate: PermissionGrant,
  now = "2026-10-03T12:00:00.000Z",
) =>
  permissionGrantMatchesExecution(candidate, {
    execution,
    principal: "worker:test",
    capability: "core.control.assign-work",
    targetRef: "ws_test",
    now,
  });

describe("CAPA subject-bound permission", () => {
  it("matches exact subject, capability, target and validity window", () => {
    expect(matches(grant)).toBe(true);
  });

  it("denies legacy, wrong-subject, wrong-target, expired and revoked grants", () => {
    const { subject: _subject, ...legacy } = grant;
    expect(matches(legacy)).toBe(false);
    expect(
      matches({
        ...grant,
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: "ws_other" as never,
        },
      }),
    ).toBe(false);
    expect(matches({ ...grant, target: "ws_other" })).toBe(false);
    expect(matches(grant, "2026-10-04T00:00:00.000Z")).toBe(false);
    expect(matches({ ...grant, state: "Revoked" })).toBe(false);
  });
});
