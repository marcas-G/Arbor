/**
 * P13-004 fixtures: 9 views × 3 (typical / minimal / unknown-enum) — pure
 * data for render tests and story reuse (`03` §2 hard requirement 2).
 * Branded IDs/revisions are cast through `id()` (`as never`); unknown-enum
 * values exercise the verbatim + muted rendering contract (`01` I5).
 */
import type {
  AttentionRes,
  CurrentWorkRes,
  DependencyRes,
  InboxViewRes,
  TranscriptRes,
  TreeViewRes,
  UsageReq,
  UsageRes,
  VerificationRes,
  WorkspaceDetailRes,
} from "@arbor/api-contracts";

const id = (value: string): never => value as never;
/** Fixture values stand in for a server-supplied canonical Work.revision. */
const workRevision = (value: number): never => value as never;

// --- responsibility-tree ---

export const treeTypical: TreeViewRes = {
  nodes: [
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000001"),
      parentWorkspaceId: null,
      name: "平台根工作区",
      status: "executing",
      currentWork: {
        workId: id("wrk_018f6a2e-0000-7000-8000-0000000000a1"),
        objective: "维护 P13 视图渲染合同",
        status: "Open",
        revision: workRevision(0),
        activeExecution: {
          executionId: id("exe_018f6a2e-0000-7000-8000-0000000000e1"),
          admittedAt: "2026-09-23T09:00:00.000Z",
        },
      },
      subtreeAttention: { attention: 2, actionRequired: 1 },
      usageSummary: {
        tokens: 1200,
        cost: {
          _tag: "Known",
          amount: 0.42,
          currency: "USD",
          priceSheetVersion: "ps-2026-09",
        },
        turns: 7,
      },
    },
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000002"),
      parentWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000001"),
      name: "前端渲染",
      status: "idle",
      subtreeAttention: { attention: 0, actionRequired: 0 },
      usageSummary: {
        tokens: 300,
        cost: { _tag: "Unknown", reason: "PartialUsage" },
        turns: 2,
      },
    },
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000003"),
      parentWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000001"),
      name: "守护进程",
      status: "waiting-blocked",
      subtreeAttention: { attention: 0, actionRequired: 0 },
    },
  ],
};

export const treeMinimal: TreeViewRes = {
  nodes: [
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000004"),
      parentWorkspaceId: null,
      name: "仅必要字段",
      status: "idle",
      subtreeAttention: { attention: 0, actionRequired: 0 },
    },
  ],
};

/** Absence is represented by omitted optional fields. In particular, a tree
 * node without current work must not carry `currentWork: null` or a dummy
 * current-work object across the frozen wire boundary. */
export const treeExplicitNulls: TreeViewRes = {
  nodes: [
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000006"),
      parentWorkspaceId: null,
      name: "显式空值节点",
      status: "idle",
      subtreeAttention: { attention: 0, actionRequired: 0 },
    },
  ],
};

export const treeUnknownEnum: TreeViewRes = {
  nodes: [
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000005"),
      parentWorkspaceId: null,
      name: "未来状态节点",
      status: "weird-state" as never,
      subtreeAttention: { attention: 0, actionRequired: 0 },
    },
  ],
};

// --- attention ---

export const attentionTypical: AttentionRes = {
  rows: [
    {
      source: "Deadlock",
      severity: "ActionRequired",
      targetWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000003"),
      dedupKey: "dl-1",
      summaryRef: "wait-cycles#1",
      occurredAt: "2026-09-23T09:12:00.000Z",
    },
    {
      source: "DependencyUnfulfillable",
      severity: "ActionRequired",
      targetWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000001"),
      dedupKey: "du-9",
      summaryRef: "dep-report#9",
      occurredAt: "2026-09-23T09:40:00.000Z",
    },
    {
      source: "VerifierOrphan",
      severity: "Attention",
      targetWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000002"),
      dedupKey: "vo-4",
      summaryRef: "verifier-orphan#4",
      occurredAt: "2026-09-23T08:55:00.000Z",
    },
  ],
};

export const attentionMinimal: AttentionRes = { rows: [] };

export const attentionUnknownEnum: AttentionRes = {
  rows: [
    {
      source: "MysterySource" as never,
      severity: "Attention",
      targetWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000002"),
      dedupKey: "ms-1",
      summaryRef: "mystery#1",
      occurredAt: "2026-09-23T10:01:00.000Z",
    },
    {
      source: "Deadlock",
      severity: "WeirdSeverity" as never,
      targetWorkspaceId: id("ws_018f6a2e-0000-7000-8000-000000000003"),
      dedupKey: "dl-2",
      summaryRef: "wait-cycles#2",
      occurredAt: "2026-09-23T10:05:00.000Z",
    },
  ],
};

// --- workspace-detail ---

export const detailTypical: WorkspaceDetailRes = {
  responsibility: {
    purpose: "承载 Arbor web 渲染合同的实施与演进",
    ownedResponsibilities: ["视图渲染", "Problem 呈现"],
    obligations: ["保持 DTO 单一输入", "未知枚举原样呈现"],
    includes: ["apps/web/src"],
    excludes: ["服务端投影"],
    interfaces: ["ViewResponseMap"],
  },
  boundary: {
    basisResponsibilityRevision: 3 as never,
    addresses: [
      { _tag: "FileTree", path: "/srv/arbor/web" },
      {
        _tag: "GitWorktree",
        path: "/srv/arbor/worktrees/p13",
        branch: "p13-views",
      },
      { _tag: "DatabaseNamespace", namespace: "arbor_main" },
      { _tag: "ExternalResource", address: "https://arbor.example/api" },
    ],
  },
  currentWork: {
    workId: id("wrk_018f6a2e-0000-7000-8000-0000000000a1"),
    objective: "交付 P13-004 视图渲染层",
    status: "Open",
    revision: workRevision(0),
    activeExecution: {
      executionId: id("exe_018f6a2e-0000-7000-8000-0000000000e1"),
      admittedAt: "2026-09-23T09:00:00.000Z",
    },
  },
  pendingWorks: [
    {
      workId: id("wrk_018f6a2e-0000-7000-8000-0000000000a2"),
      objective: "命令面板接线",
    },
    {
      workId: id("wrk_018f6a2e-0000-7000-8000-0000000000a3"),
      objective: "传输层连接管理",
    },
  ],
  executionSummary: {
    executionId: id("exe_018f6a2e-0000-7000-8000-0000000000e1"),
    admittedAt: "2026-09-23T09:00:00.000Z",
  },
  dependencies: [
    {
      dependencyId: id("dep_018f6a2e-0000-7000-8000-0000000000d1"),
      consumerWorkId: id("wrk_018f6a2e-0000-7000-8000-0000000000a1"),
      binding: { _tag: "AnyProducer" },
      state: "Unsatisfied",
    },
    {
      dependencyId: id("dep_018f6a2e-0000-7000-8000-0000000000d2"),
      consumerWorkId: id("wrk_018f6a2e-0000-7000-8000-0000000000a2"),
      binding: {
        _tag: "WorkspaceBound",
        workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000002"),
      },
      state: "Satisfied",
      satisfiedBy: id("del_018f6a2e-0000-7000-8000-0000000000b1"),
    },
  ],
  inboxUnconsumed: [
    {
      entryKey: "msg:018f6a2e-0000-7000-8000-0000000000m1",
      kind: "Message",
      summary: "来自守护进程的阻塞通知",
      watermark: 41,
    },
    {
      entryKey: "gov:018f6a2e-0000-7000-8000-0000000000g1",
      kind: "Governance",
      summary: "治理决议待确认",
      watermark: 42,
    },
  ],
  verification: {
    verificationId: id("ver_018f6a2e-0000-7000-8000-0000000000v1"),
    targetWorkRevision: workRevision(0),
    verdict: "Pass",
    criteriaResults: [
      {
        criterionId: "crit-render",
        requirement: "9 视图 ×3 fixture 全部可渲染",
        required: true,
        verdict: "Pass",
      },
      {
        criterionId: "crit-problem",
        requirement: "六类 Problem 呈现齐备",
        required: false,
        verdict: "Unknown",
      },
    ],
    evidenceRefs: [
      id("evd_018f6a2e-0000-7000-8000-0000000000f1"),
      id("evd_018f6a2e-0000-7000-8000-0000000000f2"),
    ],
    acceptance: {
      acceptanceId: id("acc_018f6a2e-0000-7000-8000-0000000000c1"),
      actor: id("human:root"),
      acceptedAt: "2026-09-23T09:30:00.000Z",
    },
  },
  auditTimeline: [
    {
      sequence: 1 as never,
      eventType: "WorkspaceCreated",
      at: "2026-09-23T08:00:00.000Z",
    },
    {
      sequence: 2 as never,
      eventType: "WorkAssigned",
      at: "2026-09-23T08:30:00.000Z",
    },
    {
      sequence: 3 as never,
      eventType: "CurrentWorkChanged",
      at: "2026-09-23T09:00:00.000Z",
    },
  ],
};

export const detailMinimal: WorkspaceDetailRes = {
  responsibility: {
    purpose: "最小职责",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  boundary: {
    basisResponsibilityRevision: 0 as never,
    addresses: [],
  },
  pendingWorks: [],
  dependencies: [],
  inboxUnconsumed: [],
  auditTimeline: [],
};

export const detailUnknownEnum: WorkspaceDetailRes = {
  ...detailMinimal,
  currentWork: {
    objective: "未来状态的工作",
    status: "weird-state" as never,
    revision: workRevision(0),
  },
  dependencies: [
    {
      dependencyId: id("dep_018f6a2e-0000-7000-8000-0000000000d3"),
      consumerWorkId: id("wrk_018f6a2e-0000-7000-8000-0000000000a4"),
      binding: { _tag: "AnyProducer" },
      state: "Teleported" as never,
    },
  ],
  auditTimeline: [
    {
      sequence: 9 as never,
      eventType: "CosmicEventHappened" as never,
      at: "2026-09-23T10:10:00.000Z",
    },
  ],
};

// --- current-work ---

export const currentWorkTypical: CurrentWorkRes = {
  workId: id("wrk_018f6a2e-0000-7000-8000-0000000000a1"),
  objective: "交付 P13-004 视图渲染层",
  status: "Open",
  revision: workRevision(0),
  activeExecution: {
    executionId: id("exe_018f6a2e-0000-7000-8000-0000000000e1"),
    admittedAt: "2026-09-23T09:00:00.000Z",
  },
};

export const currentWorkMinimal: CurrentWorkRes = {
  objective: "仅必要字段的当前工作",
  status: "Open",
  revision: workRevision(0),
};

export const currentWorkNull: CurrentWorkRes = null;

export const currentWorkUnknownEnum: CurrentWorkRes = {
  objective: "未来状态",
  status: "weird-state" as never,
  revision: workRevision(0),
};

// --- verification ---

export const verificationTypical: VerificationRes = {
  verificationId: id("ver_018f6a2e-0000-7000-8000-0000000000v1"),
  targetWorkRevision: workRevision(0),
  verdict: "Pass",
  criteriaResults: [
    {
      criterionId: "crit-render",
      requirement: "9 视图 ×3 fixture 全部可渲染",
      required: true,
      verdict: "Pass",
    },
    {
      criterionId: "crit-problem",
      requirement: "六类 Problem 呈现齐备",
      required: false,
      verdict: "Unknown",
    },
  ],
  evidenceRefs: [
    id("evd_018f6a2e-0000-7000-8000-0000000000f1"),
    id("evd_018f6a2e-0000-7000-8000-0000000000f2"),
  ],
  acceptance: {
    acceptanceId: id("acc_018f6a2e-0000-7000-8000-0000000000c1"),
    actor: id("human:root"),
    acceptedAt: "2026-09-23T09:30:00.000Z",
  },
};

export const verificationMinimal: VerificationRes = {
  criteriaResults: [],
  evidenceRefs: [],
};

export const verificationUnknownEnum: VerificationRes = {
  criteriaResults: [
    {
      criterionId: "crit-weird",
      requirement: "未知判定值原样呈现",
      required: true,
      verdict: "Banana" as never,
    },
  ],
  evidenceRefs: [],
};

// --- dependency-view ---

export const dependencyTypical: DependencyRes = {
  rows: detailTypical.dependencies,
};

export const dependencyMinimal: DependencyRes = { rows: [] };

export const dependencyUnknownEnum: DependencyRes = {
  rows: [
    {
      dependencyId: id("dep_018f6a2e-0000-7000-8000-0000000000d9"),
      consumerWorkId: id("wrk_018f6a2e-0000-7000-8000-0000000000a9"),
      binding: {
        _tag: "WorkBound",
        workId: id("wrk_018f6a2e-0000-7000-8000-0000000000a8"),
      },
      state: "Teleported" as never,
    },
  ],
};

// --- transcript ---

export const transcriptTypical: TranscriptRes = {
  entries: [
    {
      kind: "Message",
      summaryRef: "turn#12 请求评审",
      at: "2026-09-23T09:20:00.000Z",
    },
    {
      kind: "HumanInput",
      summaryRef: "turn#13 人工修正方向",
      at: "2026-09-23T09:25:00.000Z",
    },
    {
      kind: "SpecialistSettled",
      summaryRef: "turn#14 专家结论落地",
      at: "2026-09-23T09:31:00.000Z",
    },
  ],
  nextCursor: "cursor-018f6a2e-older",
};

export const transcriptMinimal: TranscriptRes = { entries: [] };

export const transcriptUnknownEnum: TranscriptRes = {
  entries: [
    {
      kind: "CosmicRay",
      summaryRef: "turn#99 未知条目类型",
      at: "2026-09-23T10:20:00.000Z",
    },
  ],
};

// --- usage ---

export const usageTypical: UsageRes = {
  rows: [
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000001"),
      tokens: 1200,
      cost: {
        _tag: "Known",
        amount: 0.42,
        currency: "USD",
        priceSheetVersion: "ps-2026-09",
      },
      turns: 7,
    },
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000002"),
      tokens: 300,
      cost: { _tag: "Unknown", reason: "PartialUsage" },
      turns: 2,
    },
  ],
};

export const usageMinimal: UsageRes = { rows: [] };

export const usageUnknownGroupBy: UsageReq["groupBy"] = "galaxy" as never;

export const usageUnknownEnum: UsageRes = {
  rows: [
    {
      workspaceId: id("ws_018f6a2e-0000-7000-8000-000000000009"),
      tokens: 11,
      cost: { _tag: "Unknown", reason: "PricingUnavailable" },
      turns: 1,
    },
  ],
};

// --- inbox-view ---

export const inboxTypical: InboxViewRes = {
  unconsumed: [
    {
      entryKey: "msg:018f6a2e-0000-7000-8000-0000000000m1",
      kind: "Message",
      summary: "来自守护进程的阻塞通知",
      watermark: 41,
    },
    {
      entryKey: "gov:018f6a2e-0000-7000-8000-0000000000g1",
      kind: "Governance",
      summary: "治理决议待确认",
      watermark: 42,
    },
  ],
};

export const inboxMinimal: InboxViewRes = { unconsumed: [] };

export const inboxUnknownEnum: InboxViewRes = {
  unconsumed: [
    {
      entryKey: "x:018f6a2e-0000-7000-8000-0000000000x1",
      kind: "MysteryKind" as never,
      summary: "未知收件箱条目",
      watermark: 77,
    },
  ],
};
