# P13 — Contract Index — Product Web Client

**Phase:** P13 · **Baseline:** DID v1.15 (G1–G4) · **Status:** FROZEN — independent review round 1 (Blocking=3) fixed, round 2 (Blocking=2) fixed; reviewer ruled fixes close the findings and this review is the baseline
**Position:** post-core product-surface phase（P0–P12 SYSTEM IMPLEMENTATION COMPLETE 不作废）

## Doc map

| Doc | Owns |
|---|---|
| `01-client-boundary-role.md` | `apps/web` 边界、角色冻结（Projection Renderer + Command Initiator）、状态纪律、依赖 DAG 规则 |
| `02-command-exposure-matrix.md` | `Command → UI exposure policy` 矩阵（Human-actionable / System-internal / Agent-originated / Recovery-only）；`SelectCurrentWork` / `SendMessage` 特殊约束 |
| `03-view-rendering.md` | 9 个 frozen view 的呈现契约、fixture/render coverage、Problem DTO typed-failure 呈现 |
| `04-design-tokens.md` | design token system（paper/ink/leaf/branch/attention/danger/muted、typography、spacing） |
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

## Phase state（本合同冻结时）

```text
P13 design closure: contracts FROZEN（独立评审两轮，Blocking=0）
P13 planning: NOT STARTED
P13 implementation: NOT AUTHORIZED
```
