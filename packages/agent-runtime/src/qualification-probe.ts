/** Process-local crash qualification seam. It is never model-facing, never
 * persisted, and production Composition leaves it absent. Tests supply a
 * probe through an explicit in-process config, then kill that process at the
 * named durable boundary. */
export interface AgentLoopQualificationProbeEvent {
  readonly boundary: "AH3BeforeStepAvailable" | "AH3AfterStepAvailable";
  readonly providerTurnId: string;
}

export type AgentLoopQualificationProbe = (
  event: AgentLoopQualificationProbeEvent,
) => Promise<void>;
