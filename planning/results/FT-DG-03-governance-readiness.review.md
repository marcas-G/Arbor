# FT-DG-03 治理决策稿审阅

日期：2026-10-04

对象：`planning/proposals/external-command-runtime-codec-decision-draft.md`

当前 SHA-256：
`6A258323A7AC980D24FA182ED8ADC5B09D9ED5612E2D2D3CBD591E58CAEDCD70`

结论：**可提交人工治理决策；未接受、未授权服务端实施。**

## 反证与原因

- F23 公开进程的 `SubmitHumanMessage` 非 UUIDv7 `MessageId` 得到 Committed。
- F23 公开进程的 `AcceptWorkOutcome` 用错误前缀 `acp_`、但正确 UUIDv7 的
  AcceptanceId，也得到 Committed。
- HTTP shell 只把 JSON 强转为 `ExternalCommandEnvelope`；TypeScript 品牌类型
  无法校验运行时输入。个别 Handler 的非空字符串检查不是封闭命令 schema。
- Web `AcceptWorkOutcomeForm` 的同类前缀错误已通过现有 `acc_` 合同修复并测试，
  但 HTTP/WS/CLI 直连仍可提交非法值，因此 Web 修复不构成系统关闭。

## 合同闭合检查

决策稿区分 wire/schema 错误与业务语义拒绝，规定 codec 所有权、认证与收据重放
的顺序、版本化指纹、历史只读比较、Model control 独立解码，以及
System/ExecutionOrigin 的同构校验。与 F21 的 CreateProject v1/v2 收据路径
必须共用一处 Application/Composition 实现，避免两套身份规则。

人工接受后先逐项落地所属 `docs/design/**`，再按 F23 红灯实施。至少应证明：
非法输入无 Receipt/Event/状态变更；合法 ID 正常工作；same-id 收据重放不变；
旧收据不被当前 codec 擅自改写。F23 通过后才移入默认功能门禁。

本审阅不是人工接受。
