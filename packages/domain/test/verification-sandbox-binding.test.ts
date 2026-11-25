import { describe, expect, it } from "vitest";
import {
  ExecutionId,
  ProjectId,
  parse,
  VerificationId,
  WorkId,
  WorkspaceId,
} from "../src/ids.js";
import { WorkRevision } from "../src/ordinals.js";
import { decodeExecutionEpisodeBinding } from "../src/sandbox-policy.js";
import {
  decodeCanonicalVerificationSandboxBindingV1,
  encodeVerificationSandboxBindingV1,
  type VerificationSandboxBindingV1,
} from "../src/verification-sandbox-binding.js";

const id = "00000000-0000-7000-8000-000000000001";
const binding: VerificationSandboxBindingV1 = {
  version: 1,
  kind: "IndependentVerification",
  projectId: parse(ProjectId)(`prj_${id}`),
  workspaceId: parse(WorkspaceId)(`ws_${id}`),
  executionId: parse(ExecutionId)(`exe_${id}`),
  verificationId: parse(VerificationId)(`ver_${id}`),
  workId: parse(WorkId)(`wrk_${id}`),
  targetWorkRevision: parse(WorkRevision)(3),
  copySetId: `vcp_${id}`,
  authorizationRevision: 1,
  sourceBasisDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
  inputManifestRef: `blob:sha256:${"c".repeat(64)}`,
  policyRevision: 1,
  issuedAt: "2026-11-16T12:00:00.000Z",
  expiresAt: "2026-11-16T13:00:00.000Z",
};

describe("independent verification sandbox binding", () => {
  it("round-trips its own canonical contract without becoming a Workspace episode", () => {
    expect(
      decodeCanonicalVerificationSandboxBindingV1(
        encodeVerificationSandboxBindingV1(binding),
      ),
    ).toEqual(binding);
    expect(decodeExecutionEpisodeBinding(binding)).toBeUndefined();
  });
  it.each([
    { executionId: "not-an-execution" },
    { targetWorkRevision: Number.MAX_SAFE_INTEGER + 1 },
    { authorizationRevision: 0 },
    { sourceBasisDigest: "/host/source" },
    { copySetId: "/host/copy" },
    { inputManifestRef: "missing-manifest" },
    { expiresAt: binding.issuedAt },
    { episodeBinding: { _tag: "WorkEpisode" } },
    { kind: "OsEnforced" },
    { version: 2 },
  ])("rejects malformed or mixed legacy fields: %j", (patch) => {
    expect(
      decodeCanonicalVerificationSandboxBindingV1(
        JSON.stringify({ ...binding, ...patch }),
      ),
    ).toBeUndefined();
  });
});
