/**
 * P13 `02` §3 envelope construction. `ExternalCommandEnvelope` mirrors the
 * composition-root transport contract verbatim (parity kept by reading
 * `apps/single-workspace/src/transport/contracts.ts`; never imported from
 * there — the web app may only depend on `@arbor/api-contracts` types).
 */
import type { HumanActionableCommand } from "./catalog.js";
import { uuidv7 } from "./uuid7.js";

export interface ExternalCommandEnvelope {
  readonly commandType: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly actor: string;
  readonly issuedAt: string;
  readonly payload: unknown;
}

/** DID Appendix A id vocabulary: `cmd_<uuid-v7>`. */
export function newCommandId(): string {
  return `cmd_${uuidv7()}`;
}

export function buildEnvelope(input: {
  readonly commandType: HumanActionableCommand;
  readonly commandId: string;
  readonly projectId: string;
  readonly actor: string;
  readonly payload: unknown;
}): ExternalCommandEnvelope {
  return {
    commandType: input.commandType,
    commandId: input.commandId,
    projectId: input.projectId,
    actor: input.actor,
    issuedAt: new Date().toISOString(),
    payload: input.payload,
  };
}
