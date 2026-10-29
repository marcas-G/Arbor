/**
 * W-06 Work page test fixtures — ws_1 作用域：currentWork 匹配 /
 * pendingWorks 匹配 / verification 全量 / 失败 Problem。Branded IDs 经
 * `id()` cast（同 views/fixtures.ts 约定）。
 */
import type {
  Problem,
  VerificationRes,
  WorkDetailRes,
  WorkspaceDetailRes,
} from "@arbor/api-contracts";

const id = (value: string): never => value as never;
const workRevision = (value: number): never => value as never;

export const WS = "ws_1";
export const WORK_CURRENT = "wrk_cur_1";
export const WORK_PENDING = "wrk_pend_1";

const baseDetail = {
  responsibility: {
    purpose: "渲染工作区",
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
} satisfies WorkspaceDetailRes;

export const detailCurrentWork: WorkspaceDetailRes = {
  ...baseDetail,
  currentWork: {
    workId: id(WORK_CURRENT),
    objective: "当前工作目标",
    status: "Open",
    revision: workRevision(7),
  },
};

export const detailPendingOnly: WorkspaceDetailRes = {
  ...baseDetail,
  pendingWorks: [{ workId: id(WORK_PENDING), objective: "待办工作目标" }],
};

export const workDetailCurrent: WorkDetailRes = {
  workId: id(WORK_CURRENT),
  projectId: id("prj_1"),
  workspaceId: id(WS),
  objective: "当前工作目标",
  why: "测试当前工作详情",
  completionExpectation: "显示工作详情",
  lifecycle: "Open",
  revision: workRevision(7),
};

export const workDetailPending: WorkDetailRes = {
  ...workDetailCurrent,
  workId: id(WORK_PENDING),
  objective: "待办工作目标",
};

export const workDetailCompleted: WorkDetailRes = {
  ...workDetailCurrent,
  lifecycle: "Completed",
  acceptedResult: {
    acceptanceId: id("acc_1"),
    verificationId: id("ver_1"),
    targetWorkRevision: workRevision(7),
    verdict: "Pass",
    actor: id("human:root"),
    acceptedAt: "2026-10-08T00:00:00.000Z",
  },
};

export const verificationFull: VerificationRes = {
  verificationId: id("ver_1"),
  targetWorkRevision: workRevision(7),
  verdict: "Pass",
  criteriaResults: [
    {
      criterionId: "crit-render",
      requirement: "10 视图 ×3 fixture 全部可渲染",
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
  evidenceRefs: [id("evd_1"), id("evd_2")],
  acceptance: {
    acceptanceId: id("acc_1"),
    actor: id("human:root"),
    acceptedAt: "2026-09-23T09:30:00.000Z",
  },
};

export const verificationEligible: VerificationRes = {
  ...verificationFull,
  acceptance: undefined,
};

export const unavailableProblem: Problem = {
  code: "view/verification-unavailable",
  category: "unavailable",
  message: "verification view failed",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {},
};
