import type { SkillRegistryService } from "@arbor/ports";
import { Effect } from "effect";
import type { AuthorityRole, InstructionFragment } from "./prompt.js";

/** DID v1.7 §8.11/§8.14; P3 `02` §7 (C1). */
export const SKILL_AUTHORITY_ROLE: AuthorityRole = "A5";

const rank = (role: AuthorityRole): number => Number(role.slice(1));

/** A skill fragment may only override A4+ (Execution Strategy or weaker). */
export const skillMayOverride = (targetRole: AuthorityRole): boolean =>
  rank(targetRole) > rank("A3");

export interface SkillLoadPlan {
  readonly summary: string;
  readonly body: string | null;
}

/**
 * Progressive disclosure (DID v1.7 §8.14): load the summary first; load the
 * body only when explicitly needed.
 */
export const progressiveLoad = (
  registry: SkillRegistryService,
  skillId: string,
  needBody: boolean,
): Effect.Effect<SkillLoadPlan, import("@arbor/ports").SkillRegistryError> =>
  Effect.gen(function* () {
    const summary = yield* registry.load(skillId, "Summary");
    const body = needBody
      ? (yield* registry.load(skillId, "Body")).content
      : null;
    return { summary: summary.content, body };
  });

/** A skill-derived fragment must be A5 and non-replaceable below A4. */
export const skillFragment = (
  identity: string,
  contentRef: string,
): InstructionFragment => ({
  identity,
  revision: 1,
  hash: "skill",
  semanticKind: "SkillGuidance",
  source: "Canonical",
  scope: "skill",
  authorityRole: SKILL_AUTHORITY_ROLE,
  strength: "Soft",
  compositionMode: "Specialize",
  activationCondition: "skill-loaded",
  lifetime: "Compressible",
  cacheClass: "SemiStable",
  budgetClass: "skill",
  modelCompatibility: [],
  contentRef,
});
