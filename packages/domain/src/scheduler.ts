import type {
  DecisionId,
  DependencyId,
  VerificationId,
  WorkspaceId,
} from "./ids.js";
import type { Revision } from "./ordinals.js";

/** DID v1.7 §8.18. */
export type WakeReason =
  | { readonly _tag: "WorkSelected" }
  | { readonly _tag: "InputArrived" }
  | { readonly _tag: "DependencySatisfied" }
  | { readonly _tag: "VerificationReturned" }
  | { readonly _tag: "HumanIntervention" }
  | { readonly _tag: "ChildDelivered" }
  | { readonly _tag: "EnvironmentChanged" }
  | { readonly _tag: "Recovery" };

/** DID v1.7 §8.16. */
export type WakeCondition =
  | {
      readonly _tag: "DependencyChanged";
      readonly dependencyId: DependencyId;
      readonly observedRevision: Revision;
    }
  | {
      readonly _tag: "DecisionChanged";
      readonly decisionId: DecisionId;
      readonly observedRevision: Revision;
    }
  | {
      readonly _tag: "VerificationChanged";
      readonly verificationId: VerificationId;
      readonly observedRevision: Revision;
    }
  | {
      readonly _tag: "InboxAdvanced";
      readonly workspaceId: WorkspaceId;
      readonly observedSequence: number;
    }
  | {
      readonly _tag: "EnvironmentChanged";
      readonly environmentRef: string;
      readonly observedRevision: string;
    }
  | { readonly _tag: "TimeReached"; readonly instant: string }
  | { readonly _tag: "Manual" };

/** DID v1.7 §8.16. `conditions` must be non-empty. */
export interface WaitSpec {
  readonly mode: "Any";
  readonly conditions: ReadonlyArray<WakeCondition>;
}
