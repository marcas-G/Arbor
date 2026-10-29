import type { AttentionRes } from "@arbor/api-contracts";
import type {
  AuthorityDecisionInput,
  AuthorityResolverPortService,
} from "@arbor/application";
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
    const seen: AuthorityDecisionInput[] = [];
    const port = {
      query: () => Effect.succeed({ value: attention, watermark: 8, lag: 0 }),
    };
    const resolver: AuthorityResolverPortService = {
      resolve: (input) => {
        seen.push(input);
        const row = attention.rows[0];
        if (
          row?.workId === undefined ||
          row.verificationId === undefined ||
          row.targetWorkRevision === undefined
        ) {
          return Effect.never;
        }
        return Effect.succeed({
          _tag: "RetryVerificationAuthority",
          principal: input.principal,
          commandId: input.envelope.commandId,
          semanticRequestFingerprint: input.semanticRequestFingerprint,
          projectId: input.envelope.projectId,
          targetWorkspaceId: row.targetWorkspaceId,
          currentOwnerId: row.targetWorkspaceId,
          workId: row.workId,
          expectedWorkRevision: row.targetWorkRevision,
          verificationId: row.verificationId,
          settledVerifierExecutionIds: [],
        });
      },
      resolveInvocation: () => Effect.never,
      resolveApproval: () => Effect.never,
    };
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

  it("shows UnboundLegacy only to the current direct-Parent human and never via row placement alone", async () => {
    const projection = {
      commandId: "cmd_018f2b3c-4d5e-7abc-8def-01234567c101" as never,
      projectId: "prj_1" as never,
      sourceWorkId: "wrk_child" as never,
      sourceVerificationId: "ver_source" as never,
      disposition: "UnboundLegacy" as const,
      reasonCode: "OriginEvidenceIncomplete" as const,
      ownerWorkspaceId: "ws_child" as never,
      recipientWorkspaceId: "ws_parent" as never,
      rootWorkspaceId: "ws_root" as never,
      createdAt: "2026-10-17T00:00:00.000Z",
      revision: 2,
      updatedAt: "2026-10-17T00:00:02.000Z",
    };
    const row = {
      entryKey: `retry-verification-unbound:${projection.commandId}`,
      kind: "Governance" as const,
      summary:
        "A historical RetryVerification receipt has incomplete origin evidence.",
      watermark: 12,
      target: {
        kind: "RetryVerificationUnboundLegacy" as const,
        commandId: projection.commandId,
        projectId: projection.projectId,
        sourceWorkId: projection.sourceWorkId,
        sourceVerificationId: projection.sourceVerificationId,
        disposition: projection.disposition,
        reasonCode: projection.reasonCode,
        createdAt: projection.createdAt,
        revision: projection.revision,
        updatedAt: projection.updatedAt,
      },
    };
    const port = {
      query: () =>
        Effect.succeed({ value: { unconsumed: [row] }, watermark: 12, lag: 0 }),
    };
    const loadInputs = () =>
      Effect.succeed({
        canonicalFacts: {
          projectId: projection.projectId,
          project: { rootWorkspaceId: projection.rootWorkspaceId },
          work: {
            workId: projection.sourceWorkId,
            projectId: projection.projectId,
            workspaceId: projection.ownerWorkspaceId,
          },
          workspace: {
            workspaceId: projection.ownerWorkspaceId,
            projectId: projection.projectId,
            parentWorkspaceId: projection.recipientWorkspaceId,
          },
        },
        grants: [],
        governance: {
          authenticatedHumans: [],
          directParentOf: [
            {
              workspaceId: projection.ownerWorkspaceId,
              parentPrincipal: "user:parent",
            },
          ],
        },
        policy: {},
      } as never);
    const face = viewQueryFaceWithRetryAvailability(
      port as never,
      {} as never,
      loadInputs as never,
      () => Effect.succeed([projection]),
    );
    const authorized = await Effect.runPromise(
      face.query(
        "inbox-view",
        { workspaceId: projection.recipientWorkspaceId },
        undefined,
        "user:parent" as never,
      ),
    );
    expect(authorized.value.unconsumed).toHaveLength(1);
    const repeated = await Effect.runPromise(
      face.query(
        "inbox-view",
        { workspaceId: projection.recipientWorkspaceId },
        undefined,
        "user:parent" as never,
      ),
    );
    expect(repeated.value.unconsumed).toHaveLength(1);
    const denied = await Effect.runPromise(
      face.query(
        "inbox-view",
        { workspaceId: projection.recipientWorkspaceId },
        undefined,
        "user:other" as never,
      ),
    );
    expect(denied.value.unconsumed).toEqual([]);
    const agentDenied = await Effect.runPromise(
      face.query(
        "inbox-view",
        { workspaceId: projection.recipientWorkspaceId },
        undefined,
        "agent:workspace-parent" as never,
      ),
    );
    expect(agentDenied.value.unconsumed).toEqual([]);
  });
});
