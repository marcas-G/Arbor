import { describe, expect, it } from "vitest";
import type {
  CommandEnvelope,
  CommandResolution,
  CommandSubmissionContext,
  DomainError,
} from "../src/index.js";
import {
  Actor,
  CommandId,
  createCommandAttempt,
  ExecutionId,
  LeaseGeneration,
  nextCommandAttempt,
  Principal,
  ProjectId,
  parse,
  resolveIdempotency,
  SemanticRequestFingerprint,
} from "../src/index.js";

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const otherCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:gaolei");
const principal = parse(Principal)("principal:runtime");

const fingerprint = (value: string) => parse(SemanticRequestFingerprint)(value);

const describeContext = (context: CommandSubmissionContext): string => {
  switch (context._tag) {
    case "External":
      return `external:${context.principal}`;
    case "ExecutionOrigin":
      return `execution:${context.executionId}:${context.fencingGeneration}`;
    case "System":
      return `system:${context.causationRef}`;
    case "RecoveryController":
      return `recovery:${context.causationRef}`;
    default: {
      const unreachable: never = context;
      return unreachable;
    }
  }
};

describe("command vocabulary", () => {
  it("resolves idempotency: new, same, and conflict", () => {
    const key = { commandId, fingerprint: fingerprint("fp-a") };
    const fresh = resolveIdempotency(null, key);
    expect(fresh.ok && fresh.value).toBe("New");

    const same = resolveIdempotency(key, {
      commandId,
      fingerprint: fingerprint("fp-a"),
    });
    expect(same.ok && same.value).toBe("SameLogicalRequest");

    const conflict = resolveIdempotency(key, {
      commandId,
      fingerprint: fingerprint("fp-b"),
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error._tag).toBe("IdempotencyConflict");
    }

    const unrelated = resolveIdempotency(key, {
      commandId: otherCommandId,
      fingerprint: fingerprint("fp-b"),
    });
    expect(unrelated.ok && unrelated.value).toBe("New");
  });

  it("envelope carries declared intent only, no trusted origin", () => {
    const envelope: CommandEnvelope<{ name: string }> = {
      commandId,
      projectId,
      actor,
      issuedAt: "2026-09-20T00:00:00.000Z",
      payload: { name: "Arbor" },
    };
    for (const field of [
      "origin",
      "principal",
      "executionId",
      "fencingGeneration",
    ]) {
      expect(field in envelope).toBe(false);
    }
  });

  it("submission context is exhaustive and carries authenticated origin", () => {
    expect(describeContext({ _tag: "External", principal })).toBe(
      `external:${principal}`,
    );
    const context: CommandSubmissionContext = {
      _tag: "ExecutionOrigin",
      principal,
      executionId: parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789ab",
      ),
      fencingGeneration: parse(LeaseGeneration)(3),
    };
    expect(describeContext(context)).toContain("execution:");
  });

  it("attempts use a local (commandId, attemptNo) ordinal", () => {
    const first = createCommandAttempt(commandId);
    expect(first).toEqual({ commandId, attemptNo: 0 });
    expect(nextCommandAttempt(first)).toEqual({ commandId, attemptNo: 1 });
  });

  it("resolution is a parameterized Committed | TerminalRejected union", () => {
    const committed: CommandResolution<number, DomainError> = {
      _tag: "Committed",
      result: 1,
    };
    const rejected: CommandResolution<number, DomainError> = {
      _tag: "TerminalRejected",
      error: { _tag: "AuthorityDenied", reason: "nope" },
    };
    expect(committed._tag).toBe("Committed");
    expect(rejected._tag).toBe("TerminalRejected");
  });
});
