# F21 浏览器功能测试失败证据

状态：`OPEN / DESIGN GAP`。基线：`codex/functional-tests@7aa83d3`。

运行命令：

```powershell
pnpm exec playwright test --config playwright.f21.config.ts
```

测试启动生产构建的后台进程，以 `ARBOR_PROJECT_ROOT` 指向新建的临时目录，并在目录内准备
`proof.txt`。浏览器从 `/` 创建项目，再提交目标与批准 `assign_work`。这些步骤成功。

之后 25 秒内没有出现“等待验收”。Provider 边界记录的最近三次工具结果均为：

```text
[Denied] tool denied: workspace filesystem mount is missing or ambiguous
```

浏览器表单在 `CreateProject` 中发送 `rootWorkspace.resourceBoundary.addresses: []`；当前
生产启动和授权流程没有使用 `ARBOR_PROJECT_ROOT`。因此本次失败证明的是资源绑定缺口，
并非模型未调用工具或审批未通过。

F21 测试放在 `tests/functional/pending/`，通过独立配置运行，不标记 skip、fixme 或预期
失败；主功能门禁继续对 F01–F20 给出真实 PASS/FAIL。治理接受并修复后，应将 F21 移入
默认 Playwright 功能门禁，删除 pending 配置。

本测试没有调用内部 Layer/Repository，也没有通过 `/commands` 或 SQLite 预建项目。
