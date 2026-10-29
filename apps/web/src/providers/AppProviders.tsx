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
  useRef,
  useState,
} from "react";
import { parseRoute } from "../api/router.js";
import { fetchProjectDirectory } from "../api/transport.js";
import { connectInvalidation } from "../data/invalidation.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { SessionProvider, useSession } from "../session/SessionContext.js";

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
  const session = useSession();
  const path = usePath();
  const routeProjectId = parseRoute(path)?.projectId ?? null;
  const routeSelection = useRef({
    path,
    token: session.token,
    generation: 0,
    pendingGeneration: null as number | null,
    validatedGeneration: null as number | null,
  });
  const [freshness, setFreshness] = useState<FreshnessValue>({
    state: "offline",
    lastWatermark: null,
  });

  // The route is the project identity. Mirror a verified route into the
  // Session's recent-project memory so the invalidation socket follows direct
  // links, refreshes, and popstate navigation. Each distinct path receives a
  // generation so an old A request cannot win after A → B → A.
  useEffect(() => {
    if (
      routeSelection.current.path !== path ||
      routeSelection.current.token !== session.token
    ) {
      routeSelection.current = {
        path,
        token: session.token,
        generation: routeSelection.current.generation + 1,
        pendingGeneration: null,
        validatedGeneration: null,
      };
    }
    const generation = routeSelection.current.generation;
    const isCurrentGeneration = (): boolean =>
      routeSelection.current.path === path &&
      routeSelection.current.token === session.token &&
      routeSelection.current.generation === generation;

    if (path === "/" || path === "") {
      routeSelection.current = {
        ...routeSelection.current,
        pendingGeneration: null,
        validatedGeneration: generation,
      };
      return;
    }
    if (session.token === null || routeProjectId === null) {
      routeSelection.current = {
        ...routeSelection.current,
        pendingGeneration: null,
        validatedGeneration: generation,
      };
      session.setProjectId(null);
      return;
    }
    if (routeSelection.current.validatedGeneration === generation) return;
    if (routeSelection.current.pendingGeneration === generation) return;

    routeSelection.current = {
      ...routeSelection.current,
      pendingGeneration: generation,
    };

    // Disconnect any prior project's invalidation stream while the route is
    // checked against the canonical local directory.
    if (session.projectId !== routeProjectId) {
      session.setProjectId(null);
    }
    void client
      .fetchQuery({
        queryKey: ["project-directory", "route-selection", path, generation],
        queryFn: ({ signal }) =>
          fetchProjectDirectory({
            token: session.token,
            signal,
            onUnauthenticated: session.reportUnauthenticated,
          }),
        staleTime: 0,
      })
      .then((data) => {
        if (!isCurrentGeneration()) return;
        routeSelection.current = {
          ...routeSelection.current,
          pendingGeneration: null,
          validatedGeneration: generation,
        };
        const routeExists =
          data?.ok === true &&
          data.dto.projects.some(
            (project) => project.projectId === routeProjectId,
          );
        session.setProjectId(routeExists ? routeProjectId : null);
      })
      .catch(() => {
        if (isCurrentGeneration()) {
          routeSelection.current = {
            ...routeSelection.current,
            pendingGeneration: null,
            validatedGeneration: generation,
          };
          session.setProjectId(null);
        }
      });
  }, [
    path,
    client,
    routeProjectId,
    session.projectId,
    session.reportUnauthenticated,
    session.setProjectId,
    session.token,
  ]);

  useEffect(() => {
    if (session.token === null || session.projectId === null) {
      setFreshness({ state: "offline", lastWatermark: null });
      return;
    }
    let hasOpened = false;
    const channel = connectInvalidation(
      wsUrl(),
      {
        onOpen: () => {
          if (hasOpened) {
            void client.invalidateQueries({ queryKey: ["view"] });
          }
          hasOpened = true;
          setFreshness((previous) => ({ ...previous, state: "fresh" }));
        },
        onClose: () => {
          setFreshness((previous) => ({ ...previous, state: "offline" }));
        },
        onUnauthenticated: session.reportUnauthenticated,
        onInvalidate: (view: ViewId, watermark: number) => {
          setFreshness({ state: "fresh", lastWatermark: watermark });
          void client.invalidateQueries({
            queryKey: ["view", view],
          });
        },
      },
      {
        firstView: {
          token: session.token,
          view: "attention",
          request: { projectId: session.projectId },
        },
      },
    );
    return () => {
      channel.close();
    };
  }, [client, session.projectId, session.reportUnauthenticated, session.token]);
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
