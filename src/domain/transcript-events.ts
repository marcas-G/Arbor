import { Schema } from "effect";

/** P1-05A (D-035 E1): transcript event payloads. Envelope is the frozen
 * P1_PERSISTENCE_CONTRACT form. Append-only; monotonic sequence per agent. */

export const SessionStarted = Schema.Struct({
  projectId: Schema.String,
  workspaceId: Schema.String,
  system: Schema.String,
});
export const UserInput = Schema.Struct({ text: Schema.String });
export const ModelTurnStarted = Schema.Struct({ step: Schema.Number });
export const ModelTurnCommitted = Schema.Struct({
  step: Schema.Number,
  content: Schema.optional(Schema.String),
  toolCalls: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, arguments: Schema.String }),
  ),
  finishReason: Schema.String,
});
export const ToolCallRequested = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  argumentsJson: Schema.String,
});
export const ToolExecutionStarted = Schema.Struct({ callId: Schema.String });
export const ToolResult = Schema.Struct({
  callId: Schema.String,
  ok: Schema.Boolean,
  output: Schema.String,
  state: Schema.Literals(["succeeded", "failed", "unknown"]),
});
export const RunFinished = Schema.Struct({ finish: Schema.String, steps: Schema.Number });
export const PauseMarker = Schema.Struct({});
export const ResumeMarker = Schema.Struct({});
export const CompactionReference = Schema.Struct({
  summaryFile: Schema.String,
  droppedCount: Schema.Number,
});
/** P1-07: agent-side workspace requests (requestId is the idempotency key). */
export const WorkspaceRequest = Schema.Struct({
  requestId: Schema.String,
  requestType: Schema.String,
  payloadJson: Schema.String,
});

export const TRANSCRIPT_SCHEMA_VERSION = 1;

export interface TranscriptEnvelope {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly timestamp: string; // RFC3339 UTC
  readonly type: string;
  readonly payload: unknown;
}

export const transcriptEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session_started"), payload: SessionStarted }),
  Schema.Struct({ type: Schema.Literal("user_input"), payload: UserInput }),
  Schema.Struct({ type: Schema.Literal("model_turn_started"), payload: ModelTurnStarted }),
  Schema.Struct({ type: Schema.Literal("model_turn_committed"), payload: ModelTurnCommitted }),
  Schema.Struct({ type: Schema.Literal("tool_call_requested"), payload: ToolCallRequested }),
  Schema.Struct({ type: Schema.Literal("tool_execution_started"), payload: ToolExecutionStarted }),
  Schema.Struct({ type: Schema.Literal("tool_result"), payload: ToolResult }),
  Schema.Struct({ type: Schema.Literal("run_finished"), payload: RunFinished }),
  Schema.Struct({ type: Schema.Literal("pause_marker"), payload: PauseMarker }),
  Schema.Struct({ type: Schema.Literal("resume_marker"), payload: ResumeMarker }),
  Schema.Struct({ type: Schema.Literal("compaction_reference"), payload: CompactionReference }),
  Schema.Struct({ type: Schema.Literal("workspace_request"), payload: WorkspaceRequest }),
]);
