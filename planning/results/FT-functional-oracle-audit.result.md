# 功能测试判定审计

日期：2026-10-04

状态：**F07、F19 已补强；F05 终态判定仍缺公开读取合同**

## 已补强的 F07

此前 F07 只断言 `SteerWork` 返回 Committed。现在的独立公开进程用例先让 Work 等待，
提交用户纠偏后检查公开 Work revision 从 0 到 1，并检查后续模型请求实际包含纠偏文本。
`tests/functional/process/human-steer.functional.test.ts` 单独运行通过。

## F19 反向时序及修复

此前 F19 仅在 Deliverable 已交付后声明 Dependency，能验证确定性匹配，却不能验证
等待中的消费者会被后续交付唤醒。新增公开进程用例
`tests/functional/process/cross-work-wake.functional.test.ts`：先声明 WorkspaceBound
Dependency 并调用 `wait(DependencyChanged, observedRevision=0)`，确认 Work 停止且依赖
Unsatisfied；然后给子 Workspace 分配生产 Work，依次 Produce、Deliver，确认该 exact
Dependency 变为 Satisfied，消费者在再次调用模型时收到相同 Deliverable ID。

红灯暴露出 `wait` 解码器把 Revision 当字符串 ID 解析，拒绝合法数值 0，使消费者
没有真正等待。`packages/agent-runtime/src/control-decode-shared.ts` 已改为把原值交给
对应 Schema 校验；单元测试覆盖 Dependency/Decision/Verification 数字版本以及字符串
伪装版本拒绝。重建生产二进制后，F19 两种时序均单独通过。

完整回归：`pnpm check` 通过（架构 155、核心 1677 + 3 skipped、Web 216）；
`pnpm test:functional` 通过（公开进程 15、Playwright 2，均零重试）。

## F05 / F22 的反证

F05 新增的“PASS 后 Work 仍 Open 且没有 Acceptance”断言通过。尝试从
`workspace-detail.auditTimeline` 判断 WorkCompleted 时，用例超时；源码确认该列表只
覆盖人工干预事件，这不是合法的 Work 终态查询。该错误断言已移除，F05 的公开证明
降为“PASS 不自动完成、Acceptance 已记录、当前 Work 清空”。

F22 从浏览器打开已验收 Work 的原链接，等待“已完成”失败，页面显示“未找到该工作”。
独立失败测试：

```powershell
pnpm exec playwright test --config playwright.pending-functional.config.ts --grep F22
```

该缺口已记录为 `planning/gaps/FT-DG-02-completed-work-observability.md`。
在 F22 通过前，不再用 F05 的当前 Work 清空推论用户能查看 Completed Work。
