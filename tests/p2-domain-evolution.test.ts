import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CommandAuthorityFact,
  type CommandRejection,
  type StopAdmission,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
  validateCommandAuthority,
} from "../packages/application/src/index.js";
import type { DomainError } from "../packages/domain/dist/index.js";
import {
  CommandId,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
  WorkspaceId,
} from "../packages/domain/dist/index.js";

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const principal = parse(Principal)("user:test");
const fingerprint = parse(SemanticRequestFingerprint)("fp");

describe("P2 domain/application artifact evolution", () => {
  it("adds ExecutionNotFound as an Application rejection, not a DomainError", () => {
    const rejection: CommandRejection = {
      _tag: "ExecutionNotFound",
      executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789ab" as never,
    };
    expect(rejection._tag).toBe("ExecutionNotFound");
    // @ts-expect-error ExecutionNotFound is Application-owned, not a DomainError
    const notDomain: DomainError = { _tag: "ExecutionNotFound" };
    void notDomain;
  });

  it("represents stopAdmission as an explicit ADT, never a boolean", () => {
    const admission: StopAdmission = { _tag: "QuiescenceControlMutation" };
    expect(admission._tag).toBe("QuiescenceControlMutation");
    // @ts-expect-error stopAdmission is an ADT, not a boolean
    const notBoolean: StopAdmission = true;
    void notBoolean;
  });

  it("accepts both P1 and P2 authority facts", () => {
    const p1: VerifiedCommandAuthority = {
      _tag: "CreateProjectAuthority",
      principal,
      commandId,
      semanticRequestFingerprint: fingerprint,
      projectId,
    };
    const p2: VerifiedRuntimeCommandAuthority = {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal,
      commandId,
      semanticRequestFingerprint: fingerprint,
      projectId,
      commandKind: "AdmitExecution",
      workspaceId,
      bindingKind: "WorkspaceMain",
    };
    const facts: ReadonlyArray<CommandAuthorityFact> = [p1, p2];
    expect(facts.map((fact) => fact._tag)).toEqual([
      "CreateProjectAuthority",
      "AdmitExecutionAuthority",
    ]);
  });

  it("rejects a runtime authority whose submission origin does not match", () => {
    const authority: VerifiedRuntimeCommandAuthority = {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal,
      commandId,
      semanticRequestFingerprint: fingerprint,
      projectId,
      commandKind: "AdmitExecution",
      workspaceId,
      bindingKind: "WorkspaceMain",
    };
    const mismatch = validateCommandAuthority(
      authority,
      { tag: "AdmitExecutionAuthority", targetMatches: () => true },
      {
        principal,
        commandId,
        projectId,
        semanticRequestFingerprint: fingerprint,
        submissionOrigin: "External",
        payload: {},
      },
    );
    expect(Option.isSome(mismatch)).toBe(true);
    expect(mismatch.pipe(Option.getOrElse(() => ""))).toContain(
      "submission origin",
    );
  });
});
