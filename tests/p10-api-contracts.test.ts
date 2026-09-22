import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  FreshnessRequirement,
  Problem,
  QueryResult,
  ViewId,
  ViewRequestMap,
  ViewResponseMap,
} from "../packages/api-contracts/src/index.js";
import {
  ATTENTION_SOURCES,
  type AttentionReq,
  type AttentionRes,
  type CurrentWorkReq,
  type CurrentWorkRes,
  type DependencyReq,
  type DependencyRes,
  type InboxViewReq,
  type InboxViewRes,
  type TranscriptReq,
  type TranscriptRes,
  type TreeViewReq,
  type TreeViewRes,
  type UsageReq,
  type UsageRes,
  type VerificationReq,
  type VerificationRes,
  type WorkspaceDetailReq,
  type WorkspaceDetailRes,
} from "../packages/api-contracts/src/index.js";
import type {
  DeliverableId,
  DependencyId,
  EvidenceId,
  ProjectId,
  SessionId,
  VerificationId,
  WorkId,
  WorkspaceId,
} from "../packages/domain/src/ids.js";
import type { ResponsibilityRevision } from "../packages/domain/src/ordinals.js";
import { VIEW_IDS } from "../packages/domain/src/projection.js";
import {
  PROJECTION_QUERY_ERROR_CODES,
  type ProjectionInvalidRequest,
  type ProjectionStale,
  type ProjectionUnavailable,
} from "../packages/ports/src/errors.js";
import type { ProjectionQueryPortService } from "../packages/ports/src/projection-query.js";

const UUID = "00000000-0000-7000-8000-000000000000";
const projectId = `prj_${UUID}` as ProjectId;
const workspaceId = `ws_${UUID}` as WorkspaceId;
const workId = `wrk_${UUID}` as WorkId;
const dependencyId = `dep_${UUID}` as DependencyId;
const deliverableId = `del_${UUID}` as DeliverableId;
const evidenceId = `evd_${UUID}` as EvidenceId;
const sessionId = `ses_${UUID}` as SessionId;
const verificationId = `ver_${UUID}` as VerificationId;
const responsibilityRevision = 1 as ResponsibilityRevision;

const keys = (value: object): ReadonlyArray<string> =>
  Object.keys(value).sort();

// --- compile-time pairing: ViewId x Req/Res both maps are exact ---

const requestCoversAllViews: Record<ViewId, unknown> = {} as ViewRequestMap;
const responseCoversAllViews: Record<ViewId, unknown> = {} as ViewResponseMap;
const noExtraRequestKeys: null = null as Exclude<keyof ViewRequestMap, ViewId>;
const noExtraResponseKeys: null = null as Exclude<
  keyof ViewResponseMap,
  ViewId
>;

const REQUEST_CONTRACTS: Record<ViewId, string> = {
  "responsibility-tree": "TreeViewReq",
  attention: "AttentionReq",
  "workspace-detail": "WorkspaceDetailReq",
  "current-work": "CurrentWorkReq",
  verification: "VerificationReq",
  "dependency-view": "DependencyReq",
  transcript: "TranscriptReq",
  usage: "UsageReq",
  "inbox-view": "InboxViewReq",
};

const RESPONSE_CONTRACTS: Record<ViewId, string> = {
  "responsibility-tree": "TreeViewRes",
  attention: "AttentionRes",
  "workspace-detail": "WorkspaceDetailRes",
  "current-work": "CurrentWorkRes",
  verification: "VerificationRes",
  "dependency-view": "DependencyRes",
  transcript: "TranscriptRes",
  usage: "UsageRes",
  "inbox-view": "InboxViewRes",
};

const barrierVariant = (
  barrier: FreshnessRequirement | undefined,
): "absent" | "minWatermark" | "maxLag" | "both" => {
  if (barrier === undefined) {
    return "absent";
  }
  const hasMin = barrier.minWatermark !== undefined;
  const hasLag = barrier.maxLag !== undefined;
  if (hasMin && hasLag) {
    return "both";
  }
  return hasMin ? "minWatermark" : "maxLag";
};

describe("P10-002 api-contracts ViewId pairing", () => {
  it("ViewRequestMap/ViewResponseMap are exact over ViewId (compile-time)", () => {
    expect(requestCoversAllViews).toBeDefined();
    expect(responseCoversAllViews).toBeDefined();
    expect(noExtraRequestKeys).toBeNull();
    expect(noExtraResponseKeys).toBeNull();
  });

  it("request/response contract tables cover exactly VIEW_IDS", () => {
    expect(VIEW_IDS).toHaveLength(9);
    expect([...VIEW_IDS].sort()).toEqual(Object.keys(REQUEST_CONTRACTS).sort());
    expect([...VIEW_IDS].sort()).toEqual(
      Object.keys(RESPONSE_CONTRACTS).sort(),
    );
    for (const view of VIEW_IDS) {
      expect(REQUEST_CONTRACTS[view]).toMatch(/Req$/);
      expect(RESPONSE_CONTRACTS[view]).toMatch(/Res$/);
    }
  });
});

describe("P10-002 freshness barrier contract (03 §2)", () => {
  it("barrier omitted by default — no implicit RYW, no implicit barrier", () => {
    const barriers: Array<FreshnessRequirement | undefined> = [];
    const service: ProjectionQueryPortService = {
      query: <Req, Res>(
        _view: ViewId,
        request: Req,
        barrier?: FreshnessRequirement,
      ) => {
        barriers.push(barrier);
        return Effect.succeed<QueryResult<Res>>({
          value: request as unknown as Res,
          watermark: 7,
          lag: 2,
        });
      },
    };
    const result = Effect.runSync(
      service.query("inbox-view", { workspaceId: "ws_x" }),
    );
    expect(barriers).toEqual([undefined]);
    expect(result.watermark).toBe(7);
    expect(result.lag).toBe(2);
    expect(result.value).toEqual({ workspaceId: "ws_x" });
    expect(keys(result)).toEqual(["lag", "value", "watermark"]);
  });

  it("barrier variants are exhaustive: absent / minWatermark / maxLag / both", () => {
    expect(barrierVariant(undefined)).toBe("absent");
    expect(barrierVariant({ minWatermark: 42 })).toBe("minWatermark");
    expect(barrierVariant({ maxLag: 3 })).toBe("maxLag");
    expect(barrierVariant({ minWatermark: 42, maxLag: 3 })).toBe("both");
  });

  it("maxLag is present as a contract-level extension field", () => {
    const barrier: FreshnessRequirement = { maxLag: 0 };
    expect(barrier.maxLag).toBe(0);
    expect(keys(barrier)).toEqual(["maxLag"]);
  });
});

describe("P10-002 Problem DTO vocabulary (DID 10.5)", () => {
  it("Problem carries exactly the six 10.5 fields", () => {
    const problemKeys: ReadonlyArray<keyof Problem> = [
      "code",
      "category",
      "message",
      "correlationId",
      "retryDisposition",
      "safeDetails",
    ];
    expect([...problemKeys].sort()).toEqual(
      [
        "category",
        "code",
        "correlationId",
        "message",
        "retryDisposition",
        "safeDetails",
      ].sort(),
    );
  });

  it("projection query failure codes are a frozen stable set", () => {
    expect([...PROJECTION_QUERY_ERROR_CODES]).toEqual([
      "projection/stale",
      "projection/unavailable",
      "projection/invalid-request",
    ]);
  });

  it("every ProjectionQueryError member uses the Problem vocabulary", () => {
    const stale: ProjectionStale = {
      _tag: "ProjectionStale",
      code: "projection/stale",
      category: "stale",
      correlationId: "corr-1",
      retryDisposition: "retryable",
      safeDetails: { watermark: 3, lag: 5 },
    };
    const unavailable: ProjectionUnavailable = {
      _tag: "ProjectionUnavailable",
      code: "projection/unavailable",
      category: "unavailable",
      correlationId: null,
      retryDisposition: "retryable",
      safeDetails: {},
    };
    const invalidRequest: ProjectionInvalidRequest = {
      _tag: "ProjectionInvalidRequest",
      code: "projection/invalid-request",
      category: "invalid-request",
      correlationId: null,
      retryDisposition: "non-retryable",
      safeDetails: { view: "transcript" },
    };
    for (const error of [stale, unavailable, invalidRequest]) {
      expect(keys(error)).toEqual([
        "_tag",
        "category",
        "code",
        "correlationId",
        "retryDisposition",
        "safeDetails",
      ]);
      expect(PROJECTION_QUERY_ERROR_CODES).toContain(error.code);
    }
    expect(
      new Set([stale.retryDisposition, invalidRequest.retryDisposition]),
    ).toEqual(new Set(["retryable", "non-retryable"]));
    expect(unavailable.correlationId).toBeNull();
  });
});

describe("P10-002 per-view DTO cores (05 §1 frozen shapes)", () => {
  it("attention fact sources are the frozen six (02 §1)", () => {
    expect([...ATTENTION_SOURCES]).toEqual([
      "DependencyUnfulfillable",
      "Deadlock",
      "RuntimeSafetyEnvelope",
      "RecoveryEscalation",
      "VerifierOrphan",
      "VacantProducer",
    ]);
  });

  it("TreeView request/response cores", () => {
    const req: TreeViewReq = { projectId, depth: 2 };
    expect(keys(req)).toEqual(["depth", "projectId"]);
    const res: TreeViewRes = {
      nodes: [
        {
          workspaceId,
          name: "root",
          status: "executing",
          subtreeAttention: { attention: 1, actionRequired: 0 },
        },
      ],
    };
    expect(keys(res.nodes[0] ?? {})).toEqual([
      "name",
      "status",
      "subtreeAttention",
      "workspaceId",
    ]);
    expect(keys(res)).toEqual(["nodes"]);
  });

  it("Attention request/response cores", () => {
    const req: AttentionReq = { projectId };
    expect(keys(req)).toEqual(["projectId"]);
    const res: AttentionRes = {
      rows: [
        {
          source: "RecoveryEscalation",
          severity: "ActionRequired",
          targetWorkspaceId: workspaceId,
          dedupKey: "exe_1|fingerprint",
          summaryRef: "blob:summary-1",
          occurredAt: "2026-09-22T00:00:00.000Z",
        },
      ],
    };
    expect(keys(res.rows[0] ?? {})).toEqual([
      "dedupKey",
      "occurredAt",
      "severity",
      "source",
      "summaryRef",
      "targetWorkspaceId",
    ]);
    expect(keys(res)).toEqual(["rows"]);
  });

  it("WorkspaceDetail request/response core round-trips fully populated", () => {
    const req: WorkspaceDetailReq = { workspaceId };
    expect(keys(req)).toEqual(["workspaceId"]);
    const res: WorkspaceDetailRes = {
      responsibility: {
        purpose: "p",
        ownedResponsibilities: ["r"],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      boundary: {
        basisResponsibilityRevision: responsibilityRevision,
        addresses: [],
      },
      pendingWorks: [{ workId, objective: "o" }],
      dependencies: [
        {
          dependencyId,
          consumerWorkId: workId,
          binding: { _tag: "AnyProducer" },
          state: "Unsatisfied",
        },
      ],
      inboxUnconsumed: [
        {
          entryKey: `msg:msg_${UUID}`,
          kind: "Message",
          summary: "s",
          watermark: 9,
        },
      ],
      auditTimeline: [
        {
          sequence: 9,
          eventType: "WorkspaceCreated",
          at: "2026-09-22T00:00:00.000Z",
        },
      ],
    };
    expect(keys(res)).toEqual([
      "auditTimeline",
      "boundary",
      "dependencies",
      "inboxUnconsumed",
      "pendingWorks",
      "responsibility",
    ]);
    const roundTrip = JSON.parse(JSON.stringify(res)) as WorkspaceDetailRes;
    expect(roundTrip).toEqual(res);
  });

  it("CurrentWork request/response cores (null when no current work)", () => {
    const req: CurrentWorkReq = { workspaceId };
    expect(keys(req)).toEqual(["workspaceId"]);
    const absent: CurrentWorkRes = null;
    expect(absent).toBeNull();
    const present: CurrentWorkRes = {
      workId,
      objective: "o",
      status: "Open",
    };
    expect(keys(present ?? {})).toEqual(["objective", "status", "workId"]);
  });

  it("Verification request/response cores", () => {
    const req: VerificationReq = { workId };
    expect(keys(req)).toEqual(["workId"]);
    const res: VerificationRes = {
      verificationId,
      verdict: "Pass",
      criteriaResults: [
        {
          criterionId: "c1",
          requirement: "r",
          required: true,
          verdict: "Pass",
        },
      ],
      evidenceRefs: [evidenceId],
    };
    expect(keys(res)).toEqual([
      "criteriaResults",
      "evidenceRefs",
      "verdict",
      "verificationId",
    ]);
  });

  it("Dependency request accepts exactly one of projectId|workspaceId", () => {
    const byProject: DependencyReq = { projectId };
    const byWorkspace: DependencyReq = { workspaceId };
    expect(keys(byProject)).toEqual(["projectId"]);
    expect(keys(byWorkspace)).toEqual(["workspaceId"]);
    const res: DependencyRes = {
      rows: [
        {
          dependencyId,
          consumerWorkId: workId,
          binding: { _tag: "WorkBound", workId },
          state: "Satisfied",
          satisfiedBy: deliverableId,
        },
      ],
    };
    expect(keys(res.rows[0] ?? {})).toEqual([
      "binding",
      "consumerWorkId",
      "dependencyId",
      "satisfiedBy",
      "state",
    ]);
    expect(keys(res)).toEqual(["rows"]);
  });

  it("Transcript request/response cores (cursor + limit)", () => {
    const req: TranscriptReq = { workspaceId, limit: 50 };
    expect(keys(req)).toEqual(["limit", "workspaceId"]);
    const paged: TranscriptReq = {
      workspaceId,
      sessionId,
      cursor: "c-1",
      limit: 50,
    };
    expect(keys(paged)).toEqual([
      "cursor",
      "limit",
      "sessionId",
      "workspaceId",
    ]);
    const res: TranscriptRes = {
      entries: [
        {
          kind: "provider-turn",
          summaryRef: "blob:t1",
          at: "2026-09-22T00:00:00.000Z",
        },
      ],
      nextCursor: "c-2",
    };
    expect(keys(res.entries[0] ?? {})).toEqual(["at", "kind", "summaryRef"]);
    expect(keys(res)).toEqual(["entries", "nextCursor"]);
  });

  it("Usage request/response cores (groupBy union)", () => {
    const req: UsageReq = { projectId, groupBy: "subtree" };
    expect(keys(req)).toEqual(["groupBy", "projectId"]);
    const res: UsageRes = {
      rows: [
        {
          workspaceId,
          tokens: 100,
          cost: {
            _tag: "Known",
            amount: 0.5,
            currency: "USD",
            priceSheetVersion: "ps-1",
          },
          turns: 2,
        },
      ],
    };
    expect(keys(res.rows[0] ?? {})).toEqual([
      "cost",
      "tokens",
      "turns",
      "workspaceId",
    ]);
    expect(keys(res)).toEqual(["rows"]);
  });

  it("InboxView request/response cores (per-row watermark)", () => {
    const req: InboxViewReq = { workspaceId };
    expect(keys(req)).toEqual(["workspaceId"]);
    const res: InboxViewRes = {
      unconsumed: [
        {
          entryKey: `msg:msg_${UUID}`,
          kind: "Governance",
          summary: "s",
          watermark: 11,
        },
      ],
    };
    expect(keys(res.unconsumed[0] ?? {})).toEqual([
      "entryKey",
      "kind",
      "summary",
      "watermark",
    ]);
    expect(keys(res)).toEqual(["unconsumed"]);
  });
});
