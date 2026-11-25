import type { ProviderTurnId } from "@arbor/domain";
import type { PortableModelRequestV2 } from "@arbor/ports";

/** Process-local continuation only; durable Step/ProviderTurn state remains
 * owned by the existing stores and fenced transactions. */
export interface OverflowRecoveryState {
  readonly overflowRecoveryAttempt: number;
  readonly replayPersistedContextLimit: boolean;
  readonly resumeOverflowCompactionProviderTurnId: ProviderTurnId | undefined;
  readonly resumeOverflowNativeCompaction: boolean;
  readonly resumeOverflowNativeCompactionInput:
    | {
        readonly manifestJson: string;
        readonly request: PortableModelRequestV2;
      }
    | undefined;
  readonly overflowReplacementProviderTurnId: ProviderTurnId | undefined;
}
