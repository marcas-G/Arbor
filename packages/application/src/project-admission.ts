export type ProjectAdmission = "Bootstrap" | "OpenRequired" | "ClosedAllowed";

const CLOSED_ALLOWED_COMMANDS = new Set([
  "StopExecution",
  "SettleExecution",
  "RevokePermission",
  "RetireWorktree",
]);

/** Safe default: every new command targets an existing Open Project unless it
 * is explicitly classified as bootstrap or a reducing/convergence action. */
export const projectAdmissionOf = (commandType: string): ProjectAdmission =>
  commandType === "CreateProject"
    ? "Bootstrap"
    : CLOSED_ALLOWED_COMMANDS.has(commandType)
      ? "ClosedAllowed"
      : "OpenRequired";
