# D-045 — 统一服务接口层

**背景**：用户修正（两次）——① 界面不能绑业务：服务输出必须是一套统一接口，web/tui/app
都是消费者；② 参照 opencode 实况（HttpApi 契约 + 生成式 SDK + 双宿主）定型。

**架构**：
```
application 层函数（接口本体，已存在）
   ├── 进程内直调：CLI / 未来 TUI（embedded 形态）
   └── server/http.ts（零逻辑 HTTP 执行器）
          ├── /api/openapi.json（契约推导）
          └── 被消费于：sdk.ts（唯一 TS 客户端）/ web console（浏览器形态）
执行隔离：POST /api/agent/runs → spawn CLI 子进程（崩溃隔离+单写者锁不变）
```

**API 面**（契约 `server/api-contract.ts`，in/out 全 Effect Schema）：
projects(init) / tree(+milestone) / agent/runs / agents/:id/events（增量
since=seq 轮询）/ workspaces/:id/accept / approvals(list|decide) / milestones。

**实现地图**：api-contract.ts（契约+openapi 推导）· http.ts（路由匹配/参数合并/
数字 query coercion/decode→dispatch→encode；accept/approvals/milestones 经
CLI 子进程复用既有实现，agent 事件直读 transcript）· sdk.ts（类型化单客户端）·
entrypoints/server.ts（api + console 双端口，console 页面仅调契约端点）。

**验收（184 tests）**：openapi 清单完整；全 API 闭环（init→spawn run→增量事件
轮询见 user_input→milestone）；契约校验 400/未知 404。两个验收揪出的契约坑
（Effect v4 decode 剥未知键 → path/query 字段必须显式进 schema；query 数字
串需 coercion）已修并记入 D-045。

**使用**：`node dist/entrypoints/server.js --home ~/.arbor` → 打开输出的
console 地址：填 project id → 看树 → 发任务 → 实时事件流 → 审批 → 固化里程碑。
