# F21 OPEN-3 — governance acceptance and owner-contract landing

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Landing base: `a766247c16a2f5d9c1791a30fe27c6f8431a14ab`

Status: **Exact OPEN-3 candidate landed to owner contracts under the user's
standing design-landing authorization. This is not implementation
authorization, qualification, or OPEN-3 closure.**

## Authority and accepted scope

- Applied proposal:
  `planning/proposals/F21-postcommit-resource-activation-recovery-draft.md`
- LF-normalized proposal SHA-256:
  `E6EEE5CE68B78328FE96D3D14387A34F9B05F31C6BE8E53D4FB2701EE7728ECE`
- Independent review of proposal commit `a766247c16a2f5d9c1791a30fe27c6f8431a14ab`:
  Blocking = 0. Its non-blocking request was included: Attention reset,
  Pending-intent snapshot, and P1 consumer-offset rewind share one
  `TransactionScope` before retained events replay.
- Standing authorization relayed for this task permits landing this exact,
  high-confidence owner package without a per-edit prompt. No new semantics
  beyond the reviewed candidate and that rebuild-atomicity clarification were
  introduced.

## Owner landing

Hashes below are SHA-256 of the LF-normalized owner-document contents after
landing. Each change is an additive OPEN-3 contract amendment; top-level System
Design/DID and their revisions are unchanged.

| Owner | Owner version / revision | Landing | LF SHA-256 |
|---|---|---|
| P1 `01` CreateProject | DID v1.35 / P1 phase-scoped closure | Profile-only Pending intent and v1 status event join the existing CreateProject transaction; ConversationOnly remains intent/event-free; existing event payloads/order remain unchanged. | `F9324BFB3A7F40B8EAF4091E7C2B052B2BEF0F1A13E0417B0D9A8E08EBB58F4D` |
| P1 `02` ports | DID v1.35 / P1 phase-scoped closure | Durable Pending/Active intent Store, exact tuple CAS/list, and activation operation that shares one transaction across claims, Active, and event. | `E048BF6AE5D1A40B65EE0ECB1C089E3DE8BB267514FC7DAA822CA739FBC02639` |
| P1 `03` transactions | P1 phase-scoped closure; DID v1.6 §7.4/§12.6 | Records the atomic new-command and post-commit activation boundaries; no nested ownership transaction. | `A3503F0FCBA8C5CC0143E5B86E31EE1EBF4E4FFD2B5DB0A0BEEF34C9CD443C0E` |
| P1 `04` SQLite schema | P1 phase-scoped closure; DID v1.6 §9.1–§9.9 | Adds path/Profile-free intent DDL and Pending index; additive migration follows current `user_version=34`; no historical backfill. | `9748143129974644C9B717ADB6665F899B058A83FBF361FA161F0EB60802BA83` |
| P1 `05` event journal | P1 phase-scoped closure; P1-DG-06 | Adds `WorkspaceResourceActivationChanged` at EventVersion 1; no existing version/reader-ceiling change. | `03C519A5F91CC22CC7BFF3B32C68E7208C9E9035836F7E91CAE12C4949AEF07F` |
| P10 `00` contract index | DID v1.17 D-1 successor; P10 status FROZEN | Points GQ3 to its Attention source and rebuild owners; no new view. | `42A818DA0E84AAE4449A17A826F7E9C04E77988D0A0A25140189ABF3E9521EE9` |
| P10 `01` inventory | P10 GQ1; status DRAFT | Keeps the same Attention view and delegates source specifics to `02`; no ViewId/query change. | `0D285BF329B309F9C89D34333150CC9F6E1254B31B2672499FD28D9A56EFF1EC` |
| P10 `02` Attention | P10 GQ3; status DRAFT | Adds one typed Pending Activation source, ActionRequired target, stable dedup identity, fixed path-free summary, and Active-only clearing. No generic corruption source/new severity. | `2958495DC1C3AAA3B40A846413D1D0F9169324950D7CFBD68AE1A7169629B75B` |
| P10 `03` freshness | P10 GQ2/GQ5; status DRAFT | Places the new status event under existing sequence watermark/barrier semantics; no implicit RYW. | `60E849C06AA0F2F6B1AD03026B6C25355EB2D13CC974F25AF936BEDAB66814D0` |
| P10 `04` rebuild | P10 GQ2; status DRAFT | Adds a source-specific projection table and requires Attention reset + Pending-intent snapshot + consumer-offset rewind in one `TransactionScope`, followed by retained-event replay. | `3873FA995640E5E5164103F4D4011CABD323957CAF158FB84E9009B9A51A82CD` |
| P10 `05` surface/ports | DID v1.17 D-1 successor; FT-DG-02 additive; status FROZEN | Adds only the AttentionSource literal and source-specific projection-store contract; no fields, ViewId, route, or path. | `15D53D6A110648892D48CBBA726AB31BC425FDB6D3E0EF4ECA4FDAE856AEBEF4` |
| P10 `07` acceptance | P10 exit/acceptance stories; status DRAFT | Adds Pending/Active, permanent-unavailability, dedup/redelivery, retention-rebuild, and reset/offset race acceptance stories. | `3B2ADF3BFE246026557B7555FA99FDD28C5060FC0CD62A06F507C1E75BC8D21F` |
| P11 `10` ownership | P11 GQ1b; status DRAFT | Binds exact-boundary activation to one claim+CAS+Active-event transaction; crash/replay/multi-daemon behavior is single-consumption, with no Processing lease or rebind. | `EF1BA6036083F6A8A9F67AA30E1268A0CD21C29B10E17D057AB65C04A429236E` |
| P12 `10` composition | DID v1.35 FT-DG-01 TR-12; status FROZEN | Adds startup-only Pending-intent scan; activation failures remain Pending and do not block unrelated recovery. Online restore requires exact current-v2 replay or restart until periodic retry is separately designed. | `5103C3A217EA44BF2D6D13A9DDB31CD115167A2AEE86E35EC72A9A0ED18137D3` |

## Cross-owner consistency and preserved boundaries

- New Profile CreateProject: Project/Workspace/Session, unchanged
  ProjectCreated(v1) and WorkspaceCreated(v1), Pending intent, Pending status
  event, and Committed receipt are one Gateway transaction. ConversationOnly
  has no intent, claim, or activation event.
- Recovery always rereads the persisted Workspace boundary and requires the
  exact pinned revision. It never re-reads the Profile catalog, changes a path,
  or falls back to another Profile. Claims + Pending→Active + Active event
  commit atomically; `BEGIN IMMEDIATE` plus the exact intent key/CAS makes
  restart, exact replay, and multiple daemons idempotent.
- P10's Pending/Active events use EventVersion 1. The exact source key is
  `(projectId, workspaceId, resourceBoundaryRevision)`; the public summary is
  fixed and path-free. Rebuild captures current Pending intents in the same
  transaction as resetting Attention rows and rewinding the P1 consumer
  offset, then replays retained events. No generic corruption source was
  introduced.
- Existing ProjectCreated/WorkspaceCreated event contracts, CreateProject
  handler/wire versions, CommandId, semantic fingerprint, receipt tuple, and
  authentication → codec → Actor → Resolver → Gateway ordering are unchanged.
  No CommandStore receipt pre-read or historical result decoder was added.
- Historical v1 payloads/receipts remain preserve-only and are never
  backfilled. A pre-intent v2 committed-but-unactivated row is not inferred
  from path/non-empty boundary/missing claim; only its exact current-v2
  post-commit replay may retry the persisted boundary. Continuing failure is
  outside the new automatic intent/Attention guarantee and remains a separate
  v2 adoption disposition.
- A restored path while the daemon remains up needs exact-v2 replay or restart
  until separately authorized periodic retry is designed. A permanently
  unavailable path remains Pending/Attention; no alternative-boundary repair
  API or automatic Profile rebind is added.
- OPEN-1 Profile-source audit and OPEN-2 historical v1 same-ID replay remain
  independently OPEN.

## Qualification and remaining work

No production code, migration implementation, test, or default gate was changed
or run in this landing. The earlier RED remains a trigger-injected
post-commit-claim failure; it is not evidence of an exact process kill. OPEN-3
still requires implementation plus fresh-daemon qualification for exact
after-commit/pre-activation kill, repeated persistent failure and path-free
Attention, same-path restart recovery, duplicate/multi-daemon consumption,
pre-commit negative behavior, and the P10 reset/snapshot/offset race before
and after commit and after journal pruning. This landing does not claim
production-recovery or F21 closure.
