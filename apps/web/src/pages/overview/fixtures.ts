/**
 * W-03 测试补充 fixture：带可解析 `gov:fpr_*:revision` entryKey 的
 * Governance inbox 条目。views/fixtures.ts 的 gov key 不满足 W-00 严格
 * 结构（无 fpr_ 前缀/revision 段），只覆盖只读降级路径；这里把
 * "待决策" 与降级两条路径都补齐。
 */
import type { InboxViewRes } from "@arbor/api-contracts";

export const inboxGovernanceDecidable: InboxViewRes = {
  unconsumed: [
    {
      entryKey: "msg:018f6a2e-0000-7000-8000-0000000000m2",
      kind: "Message",
      summary: "来自前端的例行消息",
      watermark: 40,
    },
    {
      entryKey: "gov:fpr_018f6a2e-0000-7000-8000-0000000000g1:3",
      kind: "Governance",
      summary: "组建评审：前端渲染合同变更",
      watermark: 42,
    },
    {
      entryKey: "gov:legacy-free-text",
      kind: "Governance",
      summary: "key 不合规的治理条目（只读降级）",
      watermark: 43,
    },
  ],
};
