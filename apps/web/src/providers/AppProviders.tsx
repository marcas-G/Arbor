/**
 * W-00/W-02 — the app provider tree (frozen §4 state ownership):
 * ErrorBoundary > SessionProvider > QueryClientProvider > WSInvalidation.
 *
 * TanStack Query owns ALL server state (`['view', viewId, request]` keys,
 * staleTime Infinity — freshness is WS-driven); the WS channel's ONLY
 * effect is queryClient.invalidateQueries per invalidated view (frames
 * never write cache content). The channel's connection state feeds the
 * FreshnessContext consumed by the shell's FreshnessChip.
 */
import type { ViewId } from "@arbor/api-contracts";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
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

export type FreshnessState = "fresh" | "stale" | "offline";

interface FreshnessValue {
  readonly state: FreshnessState;
  readonly lastWatermark: number | null;
}

const FreshnessContext = createContext<FreshnessValue>({
  state: "offline",
  lastWatermark: null,
});

export const useFreshness = (): FreshnessValue => useContext(FreshnessContext);

function WSInvalidationProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const client = useQueryClient();
  const [freshness, setFreshness] = useState<FreshnessValue>({
    state: "offline",
    lastWatermark: null,
  });
  useEffect(() => {
    const channel = connectInvalidation(wsUrl(), {
      onOpen: () => {
        setFreshness((previous) => ({ ...previous, state: "fresh" }));
      },
      onClose: () => {
        setFreshness((previous) => ({ ...previous, state: "offline" }));
      },
      onInvalidate: (view: ViewId, watermark: number) => {
        setFreshness({ state: "fresh", lastWatermark: watermark });
        void client.invalidateQueries({
          queryKey: ["view", view],
        });
      },
    });
    return () => {
      channel.close();
    };
  }, [client]);
  return (
    <FreshnessContext.Provider value={freshness}>
      {children}
    </FreshnessContext.Provider>
  );
}

/** Re-render on history navigation (the typed router is history-based). */
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

export function AppProviders({ children }: { readonly children: ReactNode }) {
  return (
    <ErrorBoundary>
      <SessionProvider>
        <QueryClientProvider client={queryClient}>
          <WSInvalidationProvider>{children}</WSInvalidationProvider>
        </QueryClientProvider>
      </SessionProvider>
    </ErrorBoundary>
  );
}
