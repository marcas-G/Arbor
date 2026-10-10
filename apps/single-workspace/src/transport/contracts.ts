import type {
  Problem,
  ViewRequestMap,
  ViewResponseMap,
} from "@arbor/api-contracts";
import type {
  CommandSubmissionContext,
  FreshnessRequirement,
  Principal,
  QueryResult,
  ViewId,
} from "@arbor/domain";
import type { ProjectionQueryError } from "@arbor/ports";
import type { Effect } from "effect";

/**
 * P12 `10` §1–§2 (v1.13 G6). Transport-neutral shell contracts.
 *
 * The shells RENDER the frozen `api-contracts` DTOs and FORWARD commands. They
 * do not reinterpret view semantics and never construct authority facts: the
 * only mutation face is the composition-root `ExternalSubmissionPort`, which
 * owns the resolver + `canonicalFacts` / `grants` loading (`10` §3).
 */

/** The transport result envelope: the rendered DTO on success, the frozen
 * `Problem` DTO on failure (DID §10.5). The transport adds only this envelope;
 * it never rewrites the payload. */
export type TransportResponse<A> =
  | { readonly ok: true; readonly status: number; readonly body: A }
  | { readonly ok: false; readonly status: number; readonly problem: Problem };

/** The outward projection of a `CommandReceipt` — the transport forwards the
 * receipt, it does not decide the outcome. */
export interface CommandReceiptView {
  readonly commandId: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result?: unknown;
  readonly rejection?: string;
}

/** Read-only view face: exactly the frozen `ProjectionQueryPort` binding
 * (`10` §2; P10 `05` §1). The transport renders the returned DTO as-is. */
export interface ViewQueryFace {
  readonly query: <V extends ViewId>(
    view: V,
    request: ViewRequestMap[V],
    barrier?: FreshnessRequirement,
  ) => Effect.Effect<QueryResult<ViewResponseMap[V]>, ProjectionQueryError>;
}

/** The composition-root submission face. It is the ONLY thing a transport
 * shell may call to mutate. The shell hands over the authenticated principal
 * and the raw submission context; the composition root loads `canonicalFacts`
 * / `grants` and invokes the Authority Resolver (`10` §3; P12 `02` §2). */
export interface ExternalSubmissionPort {
  readonly submit: (
    principal: Principal,
    submissionContext: CommandSubmissionContext,
    rawEnvelope: unknown,
  ) => Effect.Effect<TransportResponse<CommandReceiptView>>;
}
