# P10 — 07 Acceptance Stories

**Authority:** `01`–`06`; S2.4.1–S2.4.3/§12.5, S1 (tree overview), S4 (wait observability); P5–P9 acceptance style.
**Status:** DRAFT.

Deterministic; read-only assertions over canonical fixtures + driven commands.

- **Story A — Tree & Status**: seeded multi-level project (executing/waiting-blocked/idle/attention workspaces) → Tree query returns responsibility chain + per-node status per the frozen label map + subtree attention summaries without per-node drill-in (S2.4.1); no view write occurs (write-count snapshot).
- **Story B — Attention read-model**: fixtures for all six fact sources (incl. GAP-01 vacant producer with a retired-workspace negative case) → severities/targets/bubbling/dedup exactly per `02`; attention rows never mutate canonical state (snapshot).
- **Story C — EffectiveFacts & freshness**: watermark/lag exposed on reads; explicit barrier blocks/refuses per `03`; no implicit RYW (write then immediate read may lag; barrier forces catch-up).
- **Story D — Detail/Verification/Dependency/Transcript/Usage/Inbox views**: per-view derive assertions incl. usage aggregates (observe-only) and transcript paging over session_entries (first production read path).
- **Story E — Rebuild at scale**: materialized projections (Attention/EffectiveFacts/Tree/Usage) — force drift → orchestrated rebuild → query correctness (same state as incremental); checkpoint resume; retention touches projection rows only (journal horizon untouched — negative assertion).
- **Story F — Human intervention facts**: steer/critical-steer/formation-approval/accept/withdraw/mark-unfulfillable (human principal) → paired facts emitted same-transaction (payload per `06`); the human-stop emission branch is asserted **wire-only** (dormant until the P12 resolver — declaration + payload shape checked, no mutation invoked); Intervention Summary bubbles; WorkSteered payload back-filled (P6 shape).
- **Story G — Action surfaces**: Query (**message-mediated**: query Message → workspace-side P14 execution, read-only, result Message/Inbox back-flow rendered), Steer, Stop-request (P2 validates as frozen; no resolver invoked; external AdmitExecution likewise never called directly), Governance Change entry — all via CommandGateway only.
- **Mechanical**: view list = `01` must-set; label map exhaustive switch; P12 boundary negative (no HTTP/WS/CLI in P10 tree); P14 consume-only; P5–P9 regression guard green.
