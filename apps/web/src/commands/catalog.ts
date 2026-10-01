/**
 * P13/P14 Human-actionable set extended by P17 Resume/Cancel: the SOLE
 * source of truth for every command form's `commandType` — type-level via
 * `HumanActionableCommand`, runtime via `isHumanActionableCommand` (EC-6).
 * System-internal / agent-originated / recovery-only command types never
 * appear here.
 */
export const HUMAN_ACTIONABLE_COMMANDS = [
  "CreateProject",
  "RenameProject",
  "CloseProject",
  "RecordDecision",
  "SteerWork",
  "AcceptWorkOutcome",
  "StopExecution",
  "GrantPermission",
  "RevokePermission",
  "SubmitHumanMessage",
  "ResumeConversationResponse",
  "CancelConversationResponse",
] as const;

export type HumanActionableCommand = (typeof HUMAN_ACTIONABLE_COMMANDS)[number];

export function isHumanActionableCommand(
  value: string,
): value is HumanActionableCommand {
  return (HUMAN_ACTIONABLE_COMMANDS as readonly string[]).includes(value);
}
