import type { Problem, ViewRequestMap } from "@arbor/api-contracts";
import type { ViewId } from "@arbor/domain";
import { Effect } from "effect";
import type { TransportCore } from "./core.js";

/**
 * P12 `10` §2: the web shell. It RENDERS the `api-contracts` DTOs (as an
 * embedded JSON island) without reinterpreting view semantics, and presents
 * failures as the frozen `Problem` DTO. No view/query semantics live here.
 */

export interface WebShellRender {
  readonly status: number;
  readonly contentType: "text/html; charset=utf-8";
  readonly html: string;
}

export interface WebShell {
  readonly renderView: <V extends ViewId>(
    view: V,
    request: ViewRequestMap[V],
  ) => Effect.Effect<WebShellRender>;
}

const escapeJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

export const renderDtoIsland = (dto: unknown): string =>
  `<script type="application/json" id="arbor-dto">${escapeJson(dto)}</script>`;

export const renderProblemIsland = (problem: Problem): string =>
  `<script type="application/json" id="arbor-problem">${escapeJson(problem)}</script>`;

export const makeWebShell = (core: TransportCore): WebShell => ({
  renderView: <V extends ViewId>(view: V, request: ViewRequestMap[V]) =>
    Effect.map(
      core.queryView(view, request),
      (response): WebShellRender =>
        response.ok
          ? {
              status: response.status,
              contentType: "text/html; charset=utf-8",
              html: renderDtoIsland(response.body),
            }
          : {
              status: response.status,
              contentType: "text/html; charset=utf-8",
              html: renderProblemIsland(response.problem),
            },
    ),
});
