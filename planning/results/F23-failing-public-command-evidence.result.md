# F23 外部命令解码失败证据

日期：2026-10-04

状态：**OPEN / DESIGN GAP**

运行命令：

```powershell
pnpm exec vitest run --config vitest.pending-functional.config.ts --testNamePattern F23
```

隔离生产后台、真实 HTTP `/commands`、新 Project 与模型边界下，两个负向用例均
错误地得到 `Committed`：

1. `SubmitHumanMessage.messageId = "msg_not-a-uuid-v7"` 被写成 Pending Message；
   它不符合 Domain `MessageId = msg_<uuid-v7>`。
2. 独立 Verification PASS 后，公开 `AcceptWorkOutcome` 使用
   `acp_<uuid-v7>` 仍生成 Acceptance；Domain `AcceptanceId` 要求
   `acc_<uuid-v7>`。此例特意保持 UUIDv7 正确，只改变前缀。

Web 自己的错误前缀已通过 `apps/web/test/command-forms.test.tsx` 的先红后绿回归
修正；浏览器生产构建重新运行 F22，越过前缀检查与硬重启后，仍在原 Work 页面
“未找到该工作”处失败。这区分了 Web 生成错误、服务端入口缺失和 F22 读模型缺口。

待定测试位于 `tests/functional/pending/command-input-validation.functional.test.ts`，
不被 `pnpm check` 或正式 `pnpm test:functional` 收集。`FT-DG-03` 及
`planning/proposals/external-command-runtime-codec-decision-draft.md` 记录待治理的
跨 Command 解码、指纹和收据顺序；未接受前不在代码中借用权限错误作局部补丁。

Web 前缀修复后的回归：`pnpm check` 全绿（架构 155、核心 1677 + 3 skipped、
Web 216）；`pnpm test:functional:ui` 两条正式浏览器用例通过。加强后的 F22
隔离浏览器测试先通过公开 Verification 的 `acc_` 验收身份读取与硬重启，然后仍在
原 Work 页“已完成”不可见处失败。
