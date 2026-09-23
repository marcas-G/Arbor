/**
 * P13-007 global unauthenticated gate (EC-4): a 401 `unauthenticated`
 * problem reported by any transport blocks the whole content area; only the
 * problem presentation plus a re-login affordance remain. Re-login returns
 * to the LoginCard (token input reappears; actor memory is kept).
 */
import type { Problem } from "@arbor/api-contracts";
import { Button } from "../components/Button.js";
import { ProblemCard } from "../problems/ProblemCard.js";

export function UnauthorizedGate({
  problem,
  onRelogin,
}: {
  readonly problem: Problem;
  readonly onRelogin: () => void;
}) {
  return (
    <div className="arbor-unauthorized-gate">
      <ProblemCard problem={problem} />
      <Button variant="primary" onClick={onRelogin}>
        重新登录
      </Button>
    </div>
  );
}
