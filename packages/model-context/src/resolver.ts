import type { InformationTrustMetadata } from "@arbor/ports";
import type {
  AuthorityRole,
  CompositionMode,
  InstructionFragment,
  PromptSlot,
} from "./prompt.js";

/** DID v1.7 §8.7; P3 `02` §4. */
export type InstructionConflict =
  | "AuthorityConflict"
  | "ScopeConflict"
  | "GoalConstraintConflict"
  | "CapabilityConflict"
  | "ReplacementConflict";

export interface GovernanceIssue {
  readonly _tag: "UnresolvableCanonicalConflict";
  readonly scope: string;
  readonly fragmentIds: ReadonlyArray<string>;
}

export interface ResolvedInstructionSet {
  readonly effective: ReadonlyArray<InstructionFragment>;
  readonly suppressed: ReadonlyArray<InstructionFragment>;
  readonly conflicts: ReadonlyArray<InstructionConflict>;
  readonly governanceIssues: ReadonlyArray<GovernanceIssue>;
}

const rank = (role: AuthorityRole): number => Number(role.slice(1));

const isHard = (fragment: InstructionFragment): boolean =>
  fragment.strength === "Hard";

export interface ResolveInput {
  readonly fragments: ReadonlyArray<InstructionFragment>;
  readonly slots: ReadonlyArray<PromptSlot>;
}

/**
 * Deterministic authority/scope/composition resolution (DID v1.7 §8.6/§8.7).
 * Precedence is `Authority > Specificity > Composition > Text order`; it is
 * never prompt text order.
 */
export const resolveInstructions = (
  input: ResolveInput,
): ResolvedInstructionSet => {
  const slotById = new Map(input.slots.map((slot) => [slot.slotId, slot]));
  const effective: InstructionFragment[] = [];
  const suppressed: InstructionFragment[] = [];
  const conflicts: InstructionConflict[] = [];
  const governanceIssues: GovernanceIssue[] = [];

  for (const fragment of input.fragments) {
    if (fragment.compositionMode === "ReplaceScope") {
      const slot = slotById.get(fragment.scope);
      if (slot === undefined || !slot.replaceable) {
        conflicts.push("ReplacementConflict");
        suppressed.push(fragment);
        continue;
      }
    }
    effective.push(fragment);
  }

  const byScope = new Map<string, InstructionFragment[]>();
  for (const fragment of effective) {
    const list = byScope.get(fragment.scope) ?? [];
    list.push(fragment);
    byScope.set(fragment.scope, list);
  }

  const kept: InstructionFragment[] = [];
  for (const [, fragments] of byScope) {
    for (const fragment of fragments) {
      const overriddenByHard = fragments.some(
        (other) =>
          other !== fragment &&
          isHard(other) &&
          rank(other.authorityRole) < rank(fragment.authorityRole),
      );
      if (overriddenByHard) {
        conflicts.push("AuthorityConflict");
        suppressed.push(fragment);
        continue;
      }
      kept.push(fragment);
    }
    const canonical = fragments.filter(
      (fragment) => fragment.source === "Canonical",
    );
    const sameLevel = new Map<number, InstructionFragment[]>();
    for (const fragment of canonical) {
      const list = sameLevel.get(rank(fragment.authorityRole)) ?? [];
      list.push(fragment);
      sameLevel.set(rank(fragment.authorityRole), list);
    }
    for (const [, peers] of sameLevel) {
      const contentRefs = new Set(peers.map((peer) => peer.contentRef));
      if (peers.length > 1 && contentRefs.size > 1) {
        governanceIssues.push({
          _tag: "UnresolvableCanonicalConflict",
          scope: peers[0]?.scope ?? "",
          fragmentIds: peers.map((peer) => peer.identity),
        });
      }
    }
  }

  const ordered = kept.sort(
    (a, b) =>
      rank(a.authorityRole) - rank(b.authorityRole) ||
      a.scope.localeCompare(b.scope) ||
      a.identity.localeCompare(b.identity),
  );

  return {
    effective: ordered,
    suppressed,
    conflicts,
    governanceIssues,
  };
};

/** DID v1.7 §8.4A — only runtime-compiled canonical text may instruct. */
export const canonicalInstructionTrust: InformationTrustMetadata = {
  provenanceKind: "CanonicalInternal",
  instructionCapability: "CanonicalInstruction",
  epistemicStatus: "Established",
};

export const dataOnlyTrust = (
  provenanceKind: InformationTrustMetadata["provenanceKind"],
): InformationTrustMetadata => ({
  provenanceKind,
  instructionCapability: "DataOnly",
  epistemicStatus: "Unverified",
});

export const canRaiseAuthority = (trust: InformationTrustMetadata): boolean =>
  trust.instructionCapability === "CanonicalInstruction";

export type { CompositionMode };
