import type { ContextEpochNumber, SessionId } from "@arbor/domain";
import type { ControlBasis } from "@arbor/model-context";
import { sha256Hex } from "@arbor/ports";

export interface AgentStepContext {
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly controlBasis: ControlBasis;
  readonly bindingFingerprint: string;
  readonly inputFrontier: {
    readonly firstSequence: number | null;
    readonly lastSequence: number | null;
  };
  readonly fingerprint: string;
}

export const makeAgentStepContext = (
  input: Omit<AgentStepContext, "fingerprint">,
): AgentStepContext => ({
  ...input,
  fingerprint: sha256Hex(JSON.stringify(input)),
});
