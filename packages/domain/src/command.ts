import { Schema } from "effect";
import type { Actor, Principal } from "./actor.js";
import type { CommandId, ExecutionId, ProjectId } from "./ids.js";
import type { LeaseGeneration } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

export const SemanticRequestFingerprint = Schema.String.pipe(
  Schema.brand("SemanticRequestFingerprint"),
);
export type SemanticRequestFingerprint = Schema.Schema.Type<
  typeof SemanticRequestFingerprint
>;

export interface CommandEnvelope<C> {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly causationRef?: string;
  readonly correlationRef?: string;
  readonly payload: C;
}

export type CommandSubmissionContext =
  | { readonly _tag: "External"; readonly principal: Principal }
  | {
      readonly _tag: "ExecutionOrigin";
      readonly principal: Principal;
      readonly executionId: ExecutionId;
      readonly fencingGeneration: LeaseGeneration;
    }
  | {
      readonly _tag: "System";
      readonly principal: Principal;
      readonly causationRef: string;
    };

export interface CommandAttempt {
  readonly commandId: CommandId;
  readonly attemptNo: number;
}

export const createCommandAttempt = (
  commandId: CommandId,
  attemptNo = 0,
): CommandAttempt => ({ commandId, attemptNo });

export const nextCommandAttempt = (
  attempt: CommandAttempt,
): CommandAttempt => ({
  commandId: attempt.commandId,
  attemptNo: attempt.attemptNo + 1,
});

export type CommandResolution<Result, Rejection> =
  | { readonly _tag: "Committed"; readonly result: Result }
  | { readonly _tag: "TerminalRejected"; readonly error: Rejection };

export interface CommandReceipt<Result, Rejection> {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly schemaVersion: string;
  readonly fingerprintAlgorithmVersion: number;
  readonly resolution: CommandResolution<Result, Rejection>;
  readonly createdAt: string;
  readonly settledAt: string;
}

export interface IdempotencyKey {
  readonly commandId: CommandId;
  readonly fingerprint: SemanticRequestFingerprint;
}

export type IdempotencyOutcome = "New" | "SameLogicalRequest";

export const resolveIdempotency = (
  existing: IdempotencyKey | null,
  incoming: IdempotencyKey,
): DomainResult<IdempotencyOutcome> => {
  if (existing === null || existing.commandId !== incoming.commandId) {
    return ok("New");
  }
  if (existing.fingerprint === incoming.fingerprint) {
    return ok("SameLogicalRequest");
  }
  return err({
    _tag: "IdempotencyConflict",
    commandId: incoming.commandId,
  });
};
