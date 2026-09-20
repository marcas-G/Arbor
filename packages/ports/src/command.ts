import type {
  CommandId,
  CommandReceipt,
  ProjectId,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { CommandStoreError } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type CommandAttemptOutcome =
  | "Committed"
  | "TerminalRejected"
  | "RetryableOperationalFailure";

export type StoredCommandReceipt = CommandReceipt<unknown, unknown>;

export interface CommandStoreService {
  readonly findResolution: (
    commandId: CommandId,
  ) => Effect.Effect<
    Option.Option<StoredCommandReceipt>,
    CommandStoreError,
    TransactionScope
  >;
  readonly insertCommitted: (
    commandId: CommandId,
    projectId: ProjectId,
    fingerprint: SemanticRequestFingerprint,
    schemaVersion: string,
    fingerprintAlgorithmVersion: number,
    resultJson: string,
  ) => Effect.Effect<void, CommandStoreError, TransactionScope>;
  readonly insertTerminalRejected: (
    commandId: CommandId,
    projectId: ProjectId,
    fingerprint: SemanticRequestFingerprint,
    schemaVersion: string,
    fingerprintAlgorithmVersion: number,
    terminalErrorJson: string,
  ) => Effect.Effect<void, CommandStoreError, TransactionScope>;
  readonly recordResolvingAttempt: (
    commandId: CommandId,
    outcome: Exclude<CommandAttemptOutcome, "RetryableOperationalFailure">,
    startedAt: string,
    settledAt: string,
  ) => Effect.Effect<void, CommandStoreError, TransactionScope>;
  readonly recordRetryableAttempt: (
    commandId: CommandId,
    failureKind: string,
    startedAt: string,
    settledAt: string,
  ) => Effect.Effect<void, CommandStoreError, TransactionScope>;
}

export class CommandStore extends Context.Service<
  CommandStore,
  CommandStoreService
>()("arbor/CommandStore") {}
