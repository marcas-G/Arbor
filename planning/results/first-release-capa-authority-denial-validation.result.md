# 首版 CAPA 与可执行权限拒绝集成验证

日期：2026-10-12

候选代码快照：`b75002087f443d1bee66fc85e0894bd8a72cfb6b`。

此快照整合了已独立审阅的三项 CAPA bounded-grant / binding / expiry 修复、authority-denial B0 修复，以及一项 production resolver → ToolRuntime → Executable observation 集成测试。新增集成测试同时确认无 grant 的策略拒绝落为 `Denied` observation、executor 未运行；resolver 的 operational failure 仍作为 operational failure 返回。

验证结果：

- `pnpm build`：通过。
- `pnpm typecheck`：通过。
- Web typecheck/build：通过。
- 限定 CAPA/domain/codec/handler/Web form/P29/authority-denial/P4 测试：10 个文件、81 项通过。

此验证不包含完整 functional suite，不代表完整 S1–S4 交付。候选尚未部署；shell review 拒绝项、Orphan governance 和 P39 不在此范围，也未合入。
