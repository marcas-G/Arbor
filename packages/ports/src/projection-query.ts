import type { FreshnessRequirement, QueryResult, ViewId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { ProjectionQueryError } from "./errors.js";

/** P10 `05` §1 signature freeze: typed request per view, GQ5
 * {value, watermark, lag} envelope on every response, optional freshness
 * barrier (blocks with bounded catch-up or refuses with a typed staleness
 * marker — P10 `03` §2). */
export interface ProjectionQueryPortService {
  readonly query: <Req, Res>(
    view: ViewId,
    request: Req,
    barrier?: FreshnessRequirement,
  ) => Effect.Effect<QueryResult<Res>, ProjectionQueryError>;
}

export class ProjectionQueryPort extends Context.Service<
  ProjectionQueryPort,
  ProjectionQueryPortService
>()("arbor/ProjectionQueryPort") {}
