/**
 * P13-007 interim view transport (P13-006 data/ is parallel work; P13-008
 * swaps this for the shared client): POST /views/:view with Bearer token,
 * mirroring the submitCommand transport envelope ({ok,status,body|problem}).
 * Fetch failure / non-JSON / unexpected body degrade to a local `unavailable`
 * Problem compatible with ProblemCard. A SERVER-returned problem with
 * category "unauthenticated" escalates to the global session gate via
 * reportUnauthenticated (frozen contract `01` §4 rule 5) — local degradation
 * problems never trigger the gate.
 */
import type {
  Problem,
  ViewRequestMap,
  ViewResponseMap,
} from "@arbor/api-contracts";
import { useCallback } from "react";
import { useSession } from "./SessionContext.js";

export type ViewOutcome<Res> =
  | { readonly ok: true; readonly dto: Res }
  | { readonly ok: false; readonly problem: Problem };

const unavailableProblem = (code: string): Problem => ({
  code,
  category: "unavailable",
  message: code,
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {},
});

const isProblem = (value: unknown): value is Problem => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.category === "string" &&
    typeof record.message === "string"
  );
};

export function useArborFetch(): {
  readonly get: <View extends keyof ViewRequestMap>(
    view: View,
    request: ViewRequestMap[View],
  ) => Promise<ViewOutcome<ViewResponseMap[View]>>;
} {
  const { token, reportUnauthenticated } = useSession();
  const get = useCallback(
    async <View extends keyof ViewRequestMap>(
      view: View,
      request: ViewRequestMap[View],
    ): Promise<ViewOutcome<ViewResponseMap[View]>> => {
      const respond = (
        problem: Problem,
      ): ViewOutcome<ViewResponseMap[View]> => {
        if (problem.category === "unauthenticated") {
          reportUnauthenticated(problem);
        }
        return { ok: false, problem };
      };
      if (token === null) {
        return {
          ok: false,
          problem: unavailableProblem("view/no-session-token"),
        };
      }
      let response: Response;
      try {
        response = await fetch(`/views/${view}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
        });
      } catch {
        return { ok: false, problem: unavailableProblem("view/fetch-failed") };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, problem: unavailableProblem("view/non-json-body") };
      }
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (record.ok === true && "body" in record) {
          return {
            ok: true,
            dto: record.body as ViewResponseMap[View],
          };
        }
        if (record.ok === false && isProblem(record.problem)) {
          return respond(record.problem);
        }
      }
      return { ok: false, problem: unavailableProblem("view/unexpected-body") };
    },
    [token, reportUnauthenticated],
  );
  return { get };
}
