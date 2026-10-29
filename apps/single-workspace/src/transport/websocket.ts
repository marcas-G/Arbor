import type { ViewRequestMap } from "@arbor/api-contracts";
import type { ViewId } from "@arbor/domain";
import { Effect } from "effect";
import type { TransportCredential } from "./auth.js";
import type { TransportResponse } from "./contracts.js";
import { isViewId, type TransportCore } from "./core.js";
import { failureResponse, unknownViewProblem } from "./errors.js";

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
  readonly authorizeViewFrame: (
    frame: WebSocketFrame,
  ) => Effect.Effect<TransportResponse<never> | null>;
  /** Internal continuation after the first view-frame proof succeeded. */
  readonly handleAuthorizedViewFrame: (
    frame: WebSocketFrame,
  ) => Effect.Effect<TransportResponse<unknown>>;
  readonly handleFrame: (
    frame: WebSocketFrame,
  ) => Effect.Effect<TransportResponse<unknown>>;
}

const credentialOf = (token: string | undefined): TransportCredential | null =>
  token === undefined ? null : { token };

export const makeWebSocketShell = (core: TransportCore): WebSocketShell => {
  const handleAuthorizedViewFrame = (
    frame: WebSocketFrame,
  ): Effect.Effect<TransportResponse<unknown>> => {
    if (frame.kind !== "view") {
      return Effect.succeed(
        failureResponse(
          unknownViewProblem("unsupported websocket request frame"),
        ),
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
  };

  const authorizeViewFrame = (frame: WebSocketFrame) => {
    if (frame.kind !== "view") {
      return Effect.succeed(
        failureResponse(
          unknownViewProblem("unsupported websocket request frame"),
        ),
      );
    }
    return Effect.flatMap(
      core.authorizeSensitiveRead(credentialOf(frame.token)),
      (authorizationFailure) =>
        authorizationFailure !== null
          ? Effect.succeed(authorizationFailure)
          : isViewId(frame.view ?? "")
            ? Effect.succeed(null)
            : Effect.succeed(
                failureResponse(unknownViewProblem(frame.view ?? "")),
              ),
    );
  };

  return {
    authorizeViewFrame,
    handleAuthorizedViewFrame,
    handleFrame: (frame) => {
      if (frame.kind === "command") {
        return core.submitCommand(credentialOf(frame.token), frame.envelope);
      }
      return Effect.flatMap(authorizeViewFrame(frame), (failure) =>
        failure === null
          ? handleAuthorizedViewFrame(frame)
          : Effect.succeed(failure),
      );
    },
  };
};
