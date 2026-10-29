# FT-DG-03 — 外部 Command 缺少统一运行时解码

状态：**OPEN / 需人工治理**。影响 F23 与所有公开命令入口的数据完整性。

## 失败证据

`tests/functional/pending/command-input-validation.functional.test.ts` 启动生产后台、
创建隔离 Project，随后从公开 `/commands` 提交 `SubmitHumanMessage`，其
`messageId = "msg_not-a-uuid-v7"`。Domain `MessageId` 合同要求
`msg_<uuid-v7>`，但当前返回 `Committed`，result 仍携带该非法 ID。
第二个独立用例在真实 Verification PASS 后提交格式正确的 UUIDv7、但错误前缀
`acp_`，公开 `AcceptWorkOutcome` 同样返回 Committed。完整记录见
`planning/results/F23-failing-public-command-evidence.result.md`。

执行：

```powershell
pnpm exec vitest run --config vitest.pending-functional.config.ts --testNamePattern F23
```

同类证据：浏览器曾生成 `acp_<uuid-v7>` 而非 Domain 冻结的
`acc_<uuid-v7>` AcceptanceId，后端也接受并在 Verification View 展示。
Web 前缀已按既有合同修复并有单元回归；后端入口问题仍在。F22 浏览器用例现已
能越过该前缀错误，继续在“已完成 Work 无法读取”处失败。

## 边界定位

- HTTP shell 对 JSON 做 `as unknown as ExternalCommandEnvelope`；认证后 Core
  透传给 Composition，没有版本化 payload 解码。
- Gateway 通过 TypeScript 泛型持有 Command payload，但运行时 JSON 并不会因此
  满足 Domain 品牌 ID 或闭合字段合同。
- `SubmitHumanMessage` 仅检查字符串与非空；`AcceptWorkOutcome` 也未验证
  `acceptanceId` 的实际格式。局部表单校验不能保护 CLI、WS、远程 HTTP 客户端。
- 错误分类尚未定义“无效 wire payload”与“语义上合法、但业务前提不满足”的
  不同收据/重试行为。若逐 Handler 随意借用 `AuthorityDenied`，会把数据格式错误
  错报成权限问题。

## 决策归属

需要 System Design / DID 明确版本化运行时 Command Codec 的所有权、
decode 与指纹/收据/权限的顺序、无效 payload 的类型化外部反馈、历史收据兼容，
以及内部 System/ExecutionOrigin 命令是否共用 codec。建议合同见
`planning/proposals/external-command-runtime-codec-decision-draft.md`。

在人工治理接受前，F23 保持隔离红灯；不得只在 Web 表单或一个 Handler 中加入
字符串前缀判断并宣称外部命令入口已安全。
