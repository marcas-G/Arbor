import type { AttentionRes } from "@arbor/api-contracts";
import type { AuthorityResolverPortService } from "@arbor/application";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { viewQueryFaceWithRetryAvailability } from "../src/transport/composition.js";

const attention: AttentionRes = {
  rows: [
    {
      source: "VerifierOrphan",
      severity: "Attention",
      targetWorkspaceId: "ws_owner" as never,
      dedupKey: "verifier-orphan:ver_1",
      summaryRef: "orphan",
      occurredAt: "2026-10-12T00:00:00.000Z",
      workId: "wrk_1" as never,
      verificationId: "ver_1" as never,
      targetWorkRevision: 3,
    },
  ],
};

describe("P10 RetryVerification availability projection", () => {
  it("exposes a row action only when the same resolver authorizes the exact server-authenticated principal and target", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const port = {
      query: () => Effect.succeed({ value: attention, watermark: 8, lag: 0 }),
    };
    const resolver = {
      resolve: (input: unknown) => {
        seen.push(input as Record<string, unknown>);
        return Effect.succeed({
          _tag: "RetryVerificationAuthority",
        } as never);
      },
    } as AuthorityResolverPortService;
    const loadInputs = (envelope: unknown) => {
      expect(envelope).toMatchObject({
        commandType: "RetryVerification",
        payload: {
          workId: "wrk_1",
          verificationId: "ver_1",
          expectedWorkRevision: 3,
        },
      });
      return Effect.succeed({
        canonicalFacts: {},
        grants: [],
        governance: { authenticatedHumans: [], directParentOf: [] },
        policy: {},
      } as never);
    };
    const face = viewQueryFaceWithRetryAvailability(
      port as never,
      resolver,
      loadInputs as never,
    );
    const result = await Effect.runPromise(
      face.query(
        "attention",
        { projectId: "prj_1" as never },
        undefined,
        "user:local" as never,
      ),
    );

    expect(result.value.rows[0]?.availableActions).toEqual([
      "RetryVerification",
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.principal).toBe("user:local");
    expect(seen[0]?.submissionContext).toMatchObject({
      _tag: "External",
      principal: "user:local",
    });
  });

  it("hides the action for denial and does not infer it from stale or absent authority facts", async () => {
    const port = {
      query: () => Effect.succeed({ value: attention, watermark: 8, lag: 0 }),
    };
    const resolver = {
      resolve: () => Effect.fail({ _tag: "AuthorityDenied" }),
    } as never;
    const face = viewQueryFaceWithRetryAvailability(
      port as never,
      resolver,
      (() => Effect.succeed({}) as never) as never,
    );
    const result = await Effect.runPromise(
      face.query(
        "attention",
        { projectId: "prj_1" as never },
        undefined,
        "user:local" as never,
      ),
    );
    expect(result.value.rows[0]?.availableActions).toBeUndefined();
  });
});
