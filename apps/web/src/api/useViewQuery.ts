/**
 * W-00 — the single view-query hook (TanStack Query is the ONLY
 * server-state cache). Fetcher = api/transport; session token + 401 gate
 * escalation wired here. `request === null` disables the query (missing
 * context, e.g. no projectId yet).
 */
import type {
  ViewId,
  ViewRequestMap,
  ViewResponseMap,
} from "@arbor/api-contracts";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useSession } from "../session/SessionContext.js";
import { fetchView } from "./transport.js";

export function useViewQuery<View extends ViewId>(
  view: View,
  request: ViewRequestMap[View] | null,
): UseQueryResult<ViewResponseMap[View]> {
  const { token, reportUnauthenticated } = useSession();
  return useQuery({
    queryKey: ["view", view, request],
    enabled: request !== null && token !== null,
    queryFn: ({ signal }) =>
      fetchView(view, request as ViewRequestMap[View], {
        token,
        signal,
        onUnauthenticated: reportUnauthenticated,
      }).then((outcome) => {
        if (!outcome.ok) {
          throw outcome.problem;
        }
        return outcome.dto;
      }),
  });
}
