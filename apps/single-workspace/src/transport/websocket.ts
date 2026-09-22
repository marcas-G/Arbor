import type { ViewRequestMap } from "@arbor/api-contracts";
import type { ViewId } from "@arbor/domain";
import { Effect } from "effect";
import type { TransportCredential } from "./auth.js";
import type {
  ExternalCommandEnvelope,
  TransportResponse,
} from "./contracts.js";
import { isViewId, type TransportCore } from "./core.js";
import {
  failureResponse,
  invalidCommandProblem,
  unknownViewProblem,
} from "./errors.js";

/**
 * P12 `10` §2: the WebSocket shell. One frame in, one rendered
 * `api-contracts` DTO / `Problem` out. Frames carry the same raw command
 * envelope as HTTP; the transport still constructs no authority fact.
 */

export interface WebSocketFrame {
  readonly kind: "view" | "command";
  readonly token?: string;
  readonly view?: string;
  readonly request?: unknown;
  readonly envelope?: unknown;
}

export interface WebSocketShell {
  readonly handleFrame: (
    frame: WebSocketFrame,
  ) => Effect.Effect<TransportResponse<unknown>>;
}

const credentialOf = (token: string | undefined): TransportCredential | null =>
  token === undefined ? null : { token };

export const makeWebSocketShell = (core: TransportCore): WebSocketShell => ({
  handleFrame: (frame) => {
    if (frame.kind === "command") {
      if (typeof frame.envelope !== "object" || frame.envelope === null) {
        return Effect.succeed(
          failureResponse(invalidCommandProblem("command envelope required")),
        );
      }
      return core.submitCommand(
        credentialOf(frame.token),
        frame.envelope as ExternalCommandEnvelope,
      );
    }
    const view = frame.view ?? "";
    if (!isViewId(view)) {
      return Effect.succeed(failureResponse(unknownViewProblem(view)));
    }
    return core.queryView(
      view,
      (frame.request ?? {}) as ViewRequestMap[ViewId],
    ) as Effect.Effect<TransportResponse<unknown>>;
  },
});
