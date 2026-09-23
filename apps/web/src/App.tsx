/**
 * W-02 — the Arbor Web v1 root: providers + project-scoped router shell.
 * Login gate renders inside the shell content area when disconnected.
 */

import { AppRouter } from "./pages/AppRouter.js";
import { AppProviders } from "./providers/AppProviders.js";
import { LoginCard } from "./session/LoginCard.js";
import { useSession } from "./session/SessionContext.js";
import { UnauthorizedGate } from "./session/UnauthorizedGate.js";

function SessionGate() {
  const session = useSession();
  if (session.token === null) {
    return <LoginCard />;
  }
  if (session.unauthenticatedProblem !== null) {
    return (
      <UnauthorizedGate
        problem={session.unauthenticatedProblem}
        onRelogin={session.clearSession}
      />
    );
  }
  return <AppRouter />;
}

export function App() {
  return (
    <AppProviders>
      <SessionGate />
    </AppProviders>
  );
}
