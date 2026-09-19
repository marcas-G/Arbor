import { Schema } from "effect";
import { ExecutionId, type SessionId, WorkspaceId } from "./ids.js";
import { ContextEpochNumber, incrementOrdinal } from "./ordinals.js";

export const WorkspacePrimary = Schema.TaggedStruct("WorkspacePrimary", {
  workspaceId: WorkspaceId,
});

export const ExecutionScoped = Schema.TaggedStruct("ExecutionScoped", {
  executionId: ExecutionId,
});

export const SessionBinding = Schema.Union([WorkspacePrimary, ExecutionScoped]);

export type SessionBinding = Schema.Schema.Type<typeof SessionBinding>;

export interface SessionEntry {
  readonly sequence: number;
  readonly ref: string;
}

export interface Checkpoint {
  readonly ref: string;
}

export interface ProviderContinuation {
  readonly state: unknown;
}

export interface Session {
  readonly sessionId: SessionId;
  readonly binding: SessionBinding;
  readonly contextEpoch: ContextEpochNumber;
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly checkpoints: ReadonlyArray<Checkpoint>;
  readonly providerContinuation: ProviderContinuation;
  readonly modelContinuation: unknown;
}

export interface CreateSessionInput {
  readonly sessionId: SessionId;
  readonly binding: SessionBinding;
  readonly contextEpoch: ContextEpochNumber;
}

export const createSession = (input: CreateSessionInput): Session => ({
  sessionId: input.sessionId,
  binding: input.binding,
  contextEpoch: input.contextEpoch,
  entries: [],
  checkpoints: [],
  providerContinuation: { state: null },
  modelContinuation: null,
});

export interface AppendSessionEntryInput {
  readonly ref: string;
}

export const appendSessionEntry = (
  session: Session,
  input: AppendSessionEntryInput,
): Session => ({
  ...session,
  entries: [
    ...session.entries,
    { sequence: session.entries.length, ref: input.ref },
  ],
});

export const compactSession = (
  session: Session,
  checkpoint: Checkpoint,
): Session => ({
  ...session,
  contextEpoch: incrementOrdinal(ContextEpochNumber)(session.contextEpoch),
  checkpoints: [...session.checkpoints, checkpoint],
});
