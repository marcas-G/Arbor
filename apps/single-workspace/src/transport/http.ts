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
      const body = asRecord(request.body);
      if (body === null) {
        return Effect.succeed(
          failureResponse(invalidCommandProblem("command envelope required")),
        );
      }
      return core.submitCommand(
        bearerCredential(request.authorization),
        body as unknown as ExternalCommandEnvelope,
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
