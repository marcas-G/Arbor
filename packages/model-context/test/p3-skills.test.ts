import type { SkillRegistryService } from "@arbor/ports";
import { SkillRegistry } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  progressiveLoad,
  SKILL_AUTHORITY_ROLE,
  skillFragment,
  skillMayOverride,
} from "../src/index.js";

const fakeRegistry: SkillRegistryService = {
  available: () => Effect.succeed([]),
  load: (skillId, tier) =>
    Effect.succeed({
      skillRef: {
        skillId,
        revision: 1,
        hash: "h",
        disclosureTier: tier,
        provenance: {
          provenanceKind: "CanonicalInternal",
          instructionCapability: "CanonicalInstruction",
          epistemicStatus: "Established",
        },
      },
      content: `${skillId}:${tier}`,
    }),
};

const layer = Layer.succeed(SkillRegistry, fakeRegistry);

describe("P3 skills surface", () => {
  it("loads summary first and body only on demand", async () => {
    const summaryOnly = await Effect.runPromise(
      Effect.provide(progressiveLoad(fakeRegistry, "skill-a", false), layer),
    );
    expect(summaryOnly.summary).toBe("skill-a:Summary");
    expect(summaryOnly.body).toBeNull();

    const withBody = await Effect.runPromise(
      Effect.provide(progressiveLoad(fakeRegistry, "skill-a", true), layer),
    );
    expect(withBody.body).toBe("skill-a:Body");
  });

  it("keeps skills at A5 and unable to override A0-A3", () => {
    expect(SKILL_AUTHORITY_ROLE).toBe("A5");
    expect(skillMayOverride("A0")).toBe(false);
    expect(skillMayOverride("A3")).toBe(false);
    expect(skillMayOverride("A4")).toBe(true);
    expect(skillFragment("s", "ref").authorityRole).toBe("A5");
  });
});
