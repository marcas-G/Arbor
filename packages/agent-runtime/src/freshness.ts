import type { AgentDirective, ControlBasis } from "@arbor/model-context";

/** DID v1.7 §8.19; P3 `06` §4. Every effectful directive carries
 * `decisionBasisManifestId`; admission checks its relevant control basis. */
export type FreshnessRequirement = "None" | "Weak" | "Strong";

export interface DecisionStale {
  readonly _tag: "DecisionStale";
  readonly changed: ReadonlyArray<string>;
}

const STRONG_DIRECTIVES: ReadonlyArray<AgentDirective["_tag"]> = [
  "InvokeTool",
  "DeclareDependency",
  "RequestGovernance",
  "SpawnSpecialist",
  "ProposeChildWorkspace",
  "CompletionClaim",
];

/** Write/destructive directives require a Strong check; read-only may use Weak. */
export const requirementForDirective = (
  directive: AgentDirective,
): FreshnessRequirement =>
  STRONG_DIRECTIVES.includes(directive._tag) ? "Strong" : "Weak";

const STRONG_FIELDS: ReadonlyArray<keyof ControlBasis> = [
  "projectPolicyRevision",
  "workspacePolicyRevision",
  "responsibilityRevision",
  "resourceBoundaryRevision",
  "workRevision",
  "authorizationDigest",
  "environmentRevision",
];

const WEAK_FIELDS: ReadonlyArray<keyof ControlBasis> = ["environmentRevision"];

export const checkFreshness = (
  basis: ControlBasis,
  current: ControlBasis,
  requirement: FreshnessRequirement,
): DecisionStale | null => {
  if (requirement === "None") {
    return null;
  }
  const fields = requirement === "Strong" ? STRONG_FIELDS : WEAK_FIELDS;
  const changed = fields.filter((field) => basis[field] !== current[field]);
  return changed.length === 0
    ? null
    : { _tag: "DecisionStale", changed: changed.map(String) };
};
