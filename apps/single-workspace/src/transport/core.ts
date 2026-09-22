import type { ViewRequestMap, ViewResponseMap } from "@arbor/api-contracts";
import type { QueryResult } from "@arbor/domain";
import { VIEW_IDS, type ViewId } from "@arbor/domain";
import { Effect } from "effect";
import {
  type AuthenticatorService,
  externalContext,
  type TransportCredential,
} from "./auth.js";
import type {
  CommandReceiptView,
  ExternalCommandEnvelope,
  ExternalSubmissionPort,
  TransportResponse,
  ViewQueryFace,
} from "./contracts.js";
import {
  failureResponse,
  problemFromProjectionError,
  unauthenticatedProblem,
} from "./errors.js";

/**
 * P12 `10` §1–§2: the transport-neutral shell core. HTTP / WebSocket / CLI /
 * web-shell all render the same `api-contracts` DTOs and forward the same raw
 * commands; only the wire encoding differs. No shell reinterprets view
 * semantics, and no shell constructs an authority fact.
 */

export interface TransportCoreDeps {
  readonly views: ViewQueryFace;
  readonly authenticator: AuthenticatorService;
  readonly submission: ExternalSubmissionPort;
}

export interface TransportCore {
  readonly queryView: <V extends ViewId>(
    view: V,
    request: ViewRequestMap[V],
  ) => Effect.Effect<TransportResponse<QueryResult<ViewResponseMap[V]>>>;
  readonly submitCommand: (
    credential: TransportCredential | null,
    envelope: ExternalCommandEnvelope,
  ) => Effect.Effect<TransportResponse<CommandReceiptView>>;
}

export const isViewId = (value: string): value is ViewId =>
  (VIEW_IDS as ReadonlyArray<string>).includes(value);

export const makeTransportCore = (deps: TransportCoreDeps): TransportCore => ({
  queryView: (<V extends ViewId>(view: V, request: ViewRequestMap[V]) =>
    Effect.match(deps.views.query(view, request), {
      onFailure: (error) => failureResponse(problemFromProjectionError(error)),
      onSuccess: (body) => ({ ok: true as const, status: 200, body }),
    })) as TransportCore["queryView"],
  submitCommand: (credential, envelope) =>
    Effect.matchEffect(deps.authenticator.authenticate(credential), {
      onFailure: () =>
        Effect.succeed(failureResponse(unauthenticatedProblem())),
      onSuccess: (principal) =>
        deps.submission.submit(principal, externalContext(principal), envelope),
    }),
});
