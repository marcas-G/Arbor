# P13 — Contract Index — Product Web Client

**Phase:** P13 · **Baseline:** DID v1.15 (G1–G4), visual successor DID v1.17 TR-WPU-A · **Status:** FROZEN — independent review round 1 (Blocking=3) fixed, round 2 (Blocking=2) fixed; D-1 adopts a presentation-only successor without reopening P13
**Position:** post-core product-surface phase（P0–P12 SYSTEM IMPLEMENTATION COMPLETE 不作废）

## Doc map

| Doc | Owns |
|---|---|
| `01-client-boundary-role.md` | `apps/web` 边界、角色冻结（Projection Renderer + Command Initiator）、状态纪律、依赖 DAG 规则 |
| `02-command-exposure-matrix.md` | `Command → UI exposure policy` 矩阵（Human-actionable / System-internal / Agent-originated / Recovery-only）；`SelectCurrentWork` / `SendMessage` 特殊约束 |
| `03-view-rendering.md` | 9 个 frozen view 的呈现契约、fixture/render coverage、Problem DTO typed-failure 呈现 |
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
```
