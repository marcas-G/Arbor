/**
 * P13 `02` §2 Human-actionable set (frozen, 7): the SOLE source of truth for
 * every command form's `commandType` — type-level via `HumanActionableCommand`,
 * runtime via `isHumanActionableCommand` (EC-6). System-internal /
 * agent-originated / recovery-only command types never appear here.
 */
export const HUMAN_ACTIONABLE_COMMANDS = [
  "CreateProject",
  "RecordDecision",
  "SteerWork",
  "AcceptWorkOutcome",
  "StopExecution",
  "GrantPermission",
  "RevokePermission",
] as const;

export type HumanActionableCommand = (typeof HUMAN_ACTIONABLE_COMMANDS)[number];

export function isHumanActionableCommand(
  value: string,
): value is HumanActionableCommand {
  return (HUMAN_ACTIONABLE_COMMANDS as readonly string[]).includes(value);
}
