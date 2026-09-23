/**
 * W-00 — the app provider tree (frozen §4 state ownership):
 * ErrorBoundary > SessionProvider > QueryClientProvider > WSInvalidation.
 *
 * TanStack Query owns ALL server state (`['view', viewId, request]` keys,
 * staleTime Infinity — freshness is WS-driven); the WS channel's ONLY
 * effect is queryClient.invalidateQueries per invalidated view (frames
 * never write cache content).
 */

import type { ViewId } from "@arbor/api-contracts";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { connectInvalidation } from "../data/invalidation.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { SessionProvider } from "../session/SessionContext.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

const wsUrl = (): string =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

function WSInvalidationProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const client = useQueryClient();
  useEffect(() => {
    const channel = connectInvalidation(wsUrl(), {
      onInvalidate: (view: ViewId) => {
        void client.invalidateQueries({
          queryKey: ["view", view],
        });
      },
    });
    return () => {
      channel.close();
    };
  }, [client]);
  return <>{children}</>;
}

function RouteSync({ children }: { readonly children: ReactNode }) {
  const [, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = (): void => {
      setPath(location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return <>{children}</>;
}

export function AppProviders({ children }: { readonly children: ReactNode }) {
  return (
    <ErrorBoundary>
      <SessionProvider>
        <QueryClientProvider client={queryClient}>
          <WSInvalidationProvider>
            <RouteSync>{children}</RouteSync>
          </WSInvalidationProvider>
        </QueryClientProvider>
      </SessionProvider>
    </ErrorBoundary>
  );
}

/** Re-render helper for route changes (used until W-02's shell). */
export const usePath = (): string => {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = (): void => {
      setPath(location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return path;
};
