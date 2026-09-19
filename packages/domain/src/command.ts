import { Schema } from "effect";
import type { Actor, Principal } from "./actor.js";
import type { DomainError } from "./errors.js";
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

export type CommandResolution<R> =
  | { readonly _tag: "Committed"; readonly result: R }
  | { readonly _tag: "TerminalRejected"; readonly error: DomainError };

export interface CommandReceipt<R> {
  readonly commandId: CommandId;
  readonly fingerprint: SemanticRequestFingerprint;
  readonly resolution: CommandResolution<R>;
}

export const canonicalize = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalize(entryValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
};

const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export interface FingerprintInput<C> {
  readonly commandType: string;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly schemaVersion: string;
  readonly payload: C;
}

export const semanticRequestFingerprint = <C>(
  input: FingerprintInput<C>,
): SemanticRequestFingerprint =>
  fnv1a(
    canonicalize({
      commandType: input.commandType,
      projectId: input.projectId,
      actor: input.actor,
      schemaVersion: input.schemaVersion,
      payload: input.payload,
    }),
  ) as SemanticRequestFingerprint;

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
