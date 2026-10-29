# FT-DG-01 治理决策稿审阅

日期：2026-10-04

对象：`planning/proposals/ui-project-resource-admission-decision-draft.md`

当前 SHA-256：
`E6EC3E2E395121699A2327329B42658218C90E8912D55EE960E77E3D15D91196`

结论：**可提交人工治理决策；未接受、未授权实施。**

## 反证与实现边界

| 当前事实 | 失败场景 | 决策稿中的闭合点 |
|---|---|---|
| Web 表单提交空 `addresses` | 浏览器项目的 Verifier 无文件挂载 | 宿主资源登记 + UI 明确选择 Profile |
| 公开 `CreateProject` 接受自由路径 | 客户端可指定未登记的服务器目录，命令 Committed | v2 封闭资源选择符；v1 不再有生产新写入口 |
| Composition 在解析权限前按原 payload 算指纹 | 事后改目录会改变同 id 请求含义 | 指纹固定到 ref/version；首次执行才解析可信目录 |
| Gateway 按 `commandId` 查持久收据 | 网络断开后重试不能再执行一次 | 认证/actor 绑定后先查原收据，匹配则直接重放 |
| v1 收据没有原认证主体 | 旧 raw-path 收据不能无条件开放给远程主体 | 仅 localhost 单用户且 actor/principal 均 `user:local` 可只读重放 |
| `afterCommitted` 从原始 payload 激活边界 | v2 payload 不含可信地址；重放可能取到不同目录 | 从已持久化根 Workspace 重读规范边界，幂等激活 |

正向反证：`pnpm exec playwright test --config playwright.pending-functional.config.ts --grep F21`
目前因缺少挂载而失败。

安全反证：`pnpm exec vitest run --config vitest.pending-functional.config.ts`
目前因未登记自由路径被错误 Committed 而失败。两者分别检验“有入口”和“无旁路”，
不能互相替代。

## 决策接受后的顺序

1. 按接受稿逐份更新拥有语义的 `docs/design/**`，保留接受标识、SHA 与落地复核。
2. 在默认功能门禁以 TDD 接入正向浏览器测试和负向公开进程测试；补伪造 ref、
   actor、同 id 重放、配置变化、重启与 conversation-only 负例。
3. 实施 Port/handler/收据兼容、可信资源列表、Web 表单及持久边界激活。
4. 运行 `pnpm check`、完整 `pnpm test:functional` 和当前提交的干净检出测试；
   不把 F21 的通过代替 F22 的 Completed Work 可见性。

本审阅只说明稿件的选择与失败证据已明确，不构成人工接受。
