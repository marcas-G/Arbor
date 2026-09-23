/**
 * P13-007 session state: token/actor/projectId live in React memory ONLY
 * (frozen contract `01` §4 — no web storage, no cookies; the mechanical scan
 * lives in test/session.test.tsx). There is no principal lookup endpoint, so
 * the actor is explicit user input remembered in memory. Any transport that
 * reports a problem with category "unauthenticated" escalates here to drive
 * the global unauthorized gate (EC-4).
 */
import type { Problem } from "@arbor/api-contracts";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface SessionContextValue {
  readonly token: string | null;
  readonly actor: string | null;
  readonly projectId: string | null;
  readonly unauthenticatedProblem: Problem | null;
  readonly setSession: (token: string, actor: string) => void;
  readonly clearSession: () => void;
  readonly setProjectId: (projectId: string) => void;
  readonly reportUnauthenticated: (problem: Problem) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [unauthenticatedProblem, setUnauthenticatedProblem] =
    useState<Problem | null>(null);

  const setSession = useCallback(
    (nextToken: string, nextActor: string): void => {
      setToken(nextToken);
      setActor(nextActor);
      setUnauthenticatedProblem(null);
    },
    [],
  );

  const clearSession = useCallback((): void => {
    setToken(null);
    setUnauthenticatedProblem(null);
  }, []);

  const setProjectId = useCallback((nextProjectId: string): void => {
    setProjectIdState(nextProjectId);
  }, []);

  const reportUnauthenticated = useCallback((problem: Problem): void => {
    setUnauthenticatedProblem(problem);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      token,
      actor,
      projectId,
      unauthenticatedProblem,
      setSession,
      clearSession,
      setProjectId,
      reportUnauthenticated,
    }),
    [
      token,
      actor,
      projectId,
      unauthenticatedProblem,
      setSession,
      clearSession,
      setProjectId,
      reportUnauthenticated,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession requires SessionProvider");
  }
  return value;
}
