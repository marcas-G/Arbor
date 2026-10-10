import type { ViewRequestMap } from "@arbor/api-contracts";
import type { ViewId } from "@arbor/domain";
import { Effect } from "effect";
import type { TransportCredential } from "./auth.js";
import type { TransportResponse } from "./contracts.js";
import { isViewId, type TransportCore } from "./core.js";
import {
  failureResponse,
  invalidCommandProblem,
  unknownViewProblem,
} from "./errors.js";

/**
 * P12 `10` §2: the HTTP shell. It binds the frozen `api-contracts` DTOs
 * (`POST /views/:view` renders the view DTO; `POST /commands` forwards the raw
 * envelope) and presents failures as the frozen `Problem` DTO. No view
 * semantics are reinterpreted here.
 */

export interface HttpTransportRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body?: unknown;
}

export interface HttpShell {
  readonly handle: (
    request: HttpTransportRequest,
  ) => Effect.Effect<TransportResponse<unknown>>;
}

export const bearerCredential = (
  authorization: string | undefined,
): TransportCredential | null => {
  if (authorization === undefined) {
    return null;
  }
  // Bearer tokens pass through verbatim; Basic credentials (the optional
  // remote access gate) pass the raw scheme+value for the authenticator to
  // decode — the scheme dispatch belongs to the authenticator, not here.
  const basic = /^Basic\s+(.+)$/.exec(authorization);
  if (basic !== null) {
    return { token: authorization };
  }
  const match = /^Bearer\s+(.+)$/.exec(authorization);
  return match === null ? null : { token: match[1] ?? "" };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

export const makeHttpShell = (core: TransportCore): HttpShell => ({
  handle: (request) => {
    if (request.method === "POST" && request.path === "/commands") {
      return core.submitCommand(
        bearerCredential(request.authorization),
        request.body,
      );
    }

    const viewMatch = /^\/views\/([a-z0-9-]+)$/.exec(request.path);
    if (viewMatch !== null && request.method !== "DELETE") {
      const view = viewMatch[1] ?? "";
      if (!isViewId(view)) {
        return Effect.succeed(failureResponse(unknownViewProblem(view)));
      }
      const body = asRecord(request.body) ?? {};
      return core.queryView(
        view,
        body as ViewRequestMap[ViewId],
      ) as Effect.Effect<TransportResponse<unknown>>;
    }

    return Effect.succeed(
      failureResponse(
        invalidCommandProblem(
          `unsupported route ${request.method} ${request.path}`,
        ),
      ),
    );
  },
});
