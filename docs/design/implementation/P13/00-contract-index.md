# P13 — Contract Index — Product Web Client

**Phase:** P13 · **Baseline:** DID v1.15 (G1–G4), visual successor DID v1.17 TR-WPU-A · **Status:** FROZEN — independent review round 1 (Blocking=3) fixed, round 2 (Blocking=2) fixed; D-1 adopts a presentation-only successor without reopening P13
**Position:** post-core product-surface phase（P0–P12 SYSTEM IMPLEMENTATION COMPLETE 不作废）

## FT-DG-02 additive contract amendment (2026-10-08)

P13 renders the P10-owned read-only Work Detail view; the current frozen view
count is ten. This amendment does not reopen P13 or authorize implementation.
Absent and cross-project/workspace Work targets render the same P10-owned
NotFound/404 response. Audit references: accepted proposal SHA-256
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`; landing
package SHA-256
`266884FC5B8858CA631DC87EFA1EA29B6BFD7265FB93C324F0A5F65FF8C68433`;
decision record `planning/results/FT-DG-02-governance-acceptance-and-landing.review.md`.

## Doc map

| Doc | Owns |
|---|---|
| `01-client-boundary-role.md` | `apps/web` 边界、角色冻结（Projection Renderer + Command Initiator）、状态纪律、依赖 DAG 规则 |
| `02-command-exposure-matrix.md` | `Command → UI exposure policy` 矩阵（Human-actionable / System-internal / Agent-originated / Recovery-only）；`SelectCurrentWork` / `SendMessage` 特殊约束 |
| `03-view-rendering.md` | 10 个 frozen view 的呈现契约、fixture/render coverage、Problem DTO typed-failure 呈现 |
| `04-design-tokens.md` | TR-WPU-A design token system（modern light surfaces / Arbor Green / sans UI / semantic status / spacing-radius-density） |
| `05-transport-build.md` | 开发态 proxy、生产态 static dist 同源托管、WS invalidation 协议（TR-W1/W2）、前端构建基线与 exact pin |
| `06-acceptance.md` | 验收标准、六条硬要求、end-to-end acceptance story |

## Frozen upstream（本 phase 不改）

- api-contracts `views.ts` / `problem.ts`（P10 `05` / DID §10.5）
- P12 `10` transport shells（HTTP `POST /views/:view`、`POST /commands`、WS frames、auth→Authority Resolver、Problem 呈现）
- Domain/Application command handlers 与 Authority Resolver（唯一 enforcement）

## Tracked revisions to frozen docs（P13 拥有，随本合同冻结）

| TR | 目标 | 内容 |
|---|---|---|
| TR-W1 | P12 `10` §2 WS shell | 新增 server→client invalidation 帧（`{kind:"invalidate", view, watermark}`）：仅携带 staleness 提示，**不携带 DTO payload、不携带 view 语义**；client 收到后 refetch。传输仍不产 view 语义（P12 `10` §1 不变） |
| TR-W2 | P12 `10` §5 deployment | production daemon 同源托管 `apps/web` static dist（`/` 路径 + assets）；静态资源服务不含任何 API 语义 |
| TR-WPU-A | P13 `04` visual-only baseline | DID v1.17：modern minimal light（white/warm-neutral、Arbor Green、sans UI/body、mono technical metadata、limited optional serif、新 spacing/radius/density）取代 paper/leaf/serif + 3px shape；保留 named tokens/semantic status/no dark mode/no new icon library，零 backend 语义变化 |

## Phase state

```text
P13 design closure COMPLETE (contracts FROZEN; review Blocking=0)
P13 planning COMPLETE (planning review Blocking=0)
P13 implementation COMPLETE; P13 FORMALLY CLOSED
(planning/results/P13.result.md — EC-1..EC-14 PASS)
P13 visual successor adopted by D-1 (TR-WPU-A); visual implementation remains separately unauthorized

## Accepted Native OS Sandbox additive UI contract

The accepted Native OS Sandbox amendment adds only the human-only
`DecideSandboxPolicy` UI exposure and rendering in `01`/`02`/`03`/`06`.
P13 remains a renderer/client boundary: authority is server-side, profile
status comes from P10 DTOs, and submission uses the existing P12 authenticated
`/commands` route. No browser-local state grants policy authority.

## Accepted full-chain Native Sandbox UI contracts (V21)

P13/02 exposes only human DecideSandboxPolicy; /03 and /06 render the exact
OsEnforced/TrustedLocal variants, high-risk FullAccess consent, NeedsDecision,
safe Unavailable/Attention/503 and SandboxPolicySummaryTooLarge receipt. The
non-persisted SandboxRecoveryBindingFailure row uses fixed safe summary and
intent_at, with no repair/rebind control or raw evidence. Browser has no
automatic retry or local authority; all actions route through existing P12.

## Accepted Sandbox Policy Candidate Read Model V5

P13/03/06 render the optional Workspace Detail candidate read and map a
deliberate human selection to existing P1 command fields. Candidate IDs are
presentation-only; no candidate ID is submitted, no variant is auto-selected,
and the existing high-risk TrustedLocal confirmation and stale-refetch
behavior remain. See P13/03/06 and the V5 acceptance record.

## Accepted candidate profile binding digest V6

P13/03/06 map only the selected candidate's handle digest to P1's existing
expected field and require whole-list refetch and deliberate reselection after
a stale receipt, even when candidate ID is unchanged. See the V6 acceptance
record.

## Accepted Option A provider-tuple selector (2026-10-20)

P13/02/03/06 render and submit the selected OsEnforced providerId,
providerVersion and capabilityRevision from the P10 candidate V2 DTO; no
candidate ID or inferred tuple reaches P1. Existing human-only exposure,
confirmation, and stale/refetch behavior remain. Accepted proposal SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`.

The accepted pre-intent bootstrap adds no P13 command or wire field. P13 may
render the existing CandidateRead while the exact Executable approval is
Pending; the user submits the existing DecideSandboxPolicy fields before
resolving that approval. `ActionRevision` and `ExecutableApprovalRevision`
receipt fields share the existing generic stale/refetch display; no Action,
approval, source digest or timestamp is shown and no command is auto-resubmitted.
See P13/02/03/06 and the bootstrap/stale-binding manifest.
```
