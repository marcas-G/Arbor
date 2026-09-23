/**
 * W-06 Attention page test fixtures — prj_1 作用域：双 severity 分组 +
 * 未知 source（MysterySource）行 / 空列表 / 失败 Problem。Branded IDs
 * 经 `id()` cast（同 views/fixtures.ts 约定）。
 */
import type { AttentionRes, Problem } from "@arbor/api-contracts";

const id = (value: string): never => value as never;

export const attentionPageTypical: AttentionRes = {
  rows: [
    {
      source: "Deadlock",
      severity: "ActionRequired",
      targetWorkspaceId: id("ws_1"),
      dedupKey: "dl-1",
      summaryRef: "wait-cycles#1",
      occurredAt: "2026-09-23T09:12:00.000Z",
    },
    {
      source: "DependencyUnfulfillable",
      severity: "ActionRequired",
      targetWorkspaceId: id("ws_2"),
      dedupKey: "du-9",
      summaryRef: "dep-report#9",
      occurredAt: "2026-09-23T09:40:00.000Z",
    },
    {
      source: "VerifierOrphan",
      severity: "Attention",
      targetWorkspaceId: id("ws_3"),
      dedupKey: "vo-4",
      summaryRef: "verifier-orphan#4",
      occurredAt: "2026-09-23T08:55:00.000Z",
    },
    {
      source: "MysterySource" as never,
      severity: "Attention",
      targetWorkspaceId: id("ws_4"),
      dedupKey: "ms-1",
      summaryRef: "mystery#1",
      occurredAt: "2026-09-23T10:01:00.000Z",
    },
  ],
};

export const attentionPageEmpty: AttentionRes = { rows: [] };

export const unavailableProblem: Problem = {
  code: "view/attention-unavailable",
  category: "unavailable",
  message: "attention view failed",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {},
};
