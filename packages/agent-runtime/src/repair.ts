import type { ExecutionSettlement } from "@arbor/domain";
import {
  dataOnlyTrust,
  hashInstructionContent,
  type InstructionFragment,
} from "@arbor/model-context";

/** DID v1.7 §6A.8; P3 `06` §3. `ModelOutputContractViolation` is NOT a provider
 * transport failure; it is repaired under a bounded policy. */

export interface RepairPolicy {
  readonly maxRepairs: number;
}

export type RepairDecision =
  | { readonly _tag: "Repair"; readonly repairFragment: InstructionFragment }
  | {
      readonly _tag: "Exhausted";
      readonly settlement: ExecutionSettlement;
    };

const isSafetySignal = (reason: string): boolean =>
  /loop|repeat|safety|stuck/i.test(reason);

/** A4 Execution-Strategy repair fragment bound to the violated contract. */
export const repairFragment = (
  outputContractRef: string,
  reason: string,
): InstructionFragment => {
  const text = `Repair ${outputContractRef}: ${reason}`;
  return {
    identity: `repair:${outputContractRef}`,
    revision: 1,
    hash: hashInstructionContent(text),
    semanticKind: "OutputContractRepair",
    source: "DynamicSurface",
    scope: "output-contract-repair",
    authorityRole: "A4",
    strength: "Soft",
    compositionMode: "Extend",
    activationCondition: "contract-violation",
    lifetime: "Evictable",
    cacheClass: "TurnDynamic",
    budgetClass: "repair",
    modelCompatibility: [],
    contentRef: text,
    provenance: dataOnlyTrust("ModelDerived"),
  };
};

export const decideRepair = (
  policy: RepairPolicy,
  repairAttempt: number,
  outputContractRef: string,
  violationReason: string,
): RepairDecision => {
  if (repairAttempt < policy.maxRepairs) {
    return {
      _tag: "Repair",
      repairFragment: repairFragment(outputContractRef, violationReason),
    };
  }
  return {
    _tag: "Exhausted",
    settlement: isSafetySignal(violationReason)
      ? {
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        }
      : {
          _tag: "Failed",
          failure: { _tag: "ExecutionFailure", reason: violationReason },
        },
  };
};
