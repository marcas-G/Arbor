# F21 OPEN-3 level-triggered Attention reconciliation landing

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Status: **Owner-contract amendment landed under the user's standing
design-landing authorization. This is not implementation authorization,
qualification, or OPEN-3 closure.**

## Why the previous landing is superseded

The source-projection portion of owner landing `ff949ebf4ebe8a998deaa62e454d2913d08d5747`
treated the P1 status event as the driver of Activation Attention projection
state. Independent review found that P1 `05` can return
`ConsumerRebuildRefused` when the generic consumer offset falls below the
retained journal floor; that refusal prevents the generic rebuild from
reaching a P10 intent snapshot. An event-driven-only path therefore could not
restore a missing Activation Attention row in that state.

The amended contract makes `WorkspaceResourceActivationChanged(v1)` a journal
and wakeup hint, not projection truth. P10 reconciles only the
`WorkspaceResourceActivationPending` source rows from the current P1
`WorkspaceResourceActivationIntent` table. P12 invokes this source-specific
reconciliation after every post-commit activation attempt and at startup for
every project with intents, including Active intents so stale Pending rows
are removed. P10 event delivery re-reads current P1 source truth; a delayed
Pending event cannot revive an Active row.

This path does not call generic rebuild and never reads, resets, skips, or
advances the shared P1 consumer offset. A generic `ConsumerRebuildRefused`
remains in force and is not claimed repaired. Full P10 rebuild retains its
separate atomic contract: Activation-source reset, consistent Pending-intent
snapshot, and P1 Attention offset rewind to `floor - 1` share one
`TransactionScope`; retained events are replayed afterward. P11's
`BEGIN IMMEDIATE` transition serializes with the snapshot/reconcile writes.

The documented counterexamples are: (1) an intent remains Pending after its
event has been pruned and the Activation row is absent while the generic
offset is below floor; P12 reconciliation restores exactly one row without
changing that offset; (2) P11 commits Pending→Active concurrently with P12
reconciliation or full rebuild; transaction serialization and current-table
reads yield a Pending row only before Active commits, and no row afterward,
even if an old Pending event is replayed. These are required future
qualification cases, not evidence already run.

## Authority and updated proposal

- Proposal: `planning/proposals/F21-postcommit-resource-activation-recovery-draft.md`
- Previous accepted proposal LF SHA-256:
  `E6EEE5CE68B78328FE96D3D14387A34F9B05F31C6BE8E53D4FB2701EE7728ECE`
- Current amended proposal LF SHA-256:
  `B85A74254CA795E4D85DDE0DD9DD9C28CD2779CB36B6F12B935B5B7BD1FDD536`
- The user standing authorization relayed for this task permits high-confidence
  owner design landing. The amendment narrows the mechanism to satisfy the
  existing P1 refusal contract; it does not authorize implementation and does
  not alter ProjectCreated v1, the F23 command tuple, historical v1
  preserve-only behavior, pre-intent v2 no-backfill, or the exact-boundary
  activation rules.
- OPEN-1 Profile-source audit and OPEN-2 historical v1 same-ID replay remain
  independently OPEN. Permanent path unavailability remains Pending/visible;
  no automatic Profile replacement is introduced. Online restoration still
  requires exact current-v2 replay or restart until separately governed
  periodic retry exists.

## Current owner-document digests

Hashes are SHA-256 of LF-normalized file contents. The rows marked amended
supersede the corresponding source-projection/startup wording in the earlier
landing record; unchanged owner contracts are listed to make this package
auditable as a whole.

| Owner file | Change in this amendment | LF SHA-256 |
|---|---|---|
| P1 `01-command-contracts.md` | Unchanged: Profile CreateProject intent/event transaction contract. | `F9324BFB3A7F40B8EAF4091E7C2B052B2BEF0F1A13E0417B0D9A8E08EBB58F4D` |
| P1 `02-port-contracts.md` | Adds deterministic `listAll` for stale Active-row reconciliation. | `F1EE1349018ABA12A9AC4E4600C14B06212AAD55569504A6BE663B71833E2041` |
| P1 `03-transaction-model.md` | Unchanged: Gateway and activation transaction boundaries. | `A3503F0FCBA8C5CC0143E5B86E31EE1EBF4E4FFD2B5DB0A0BEEF34C9CD443C0E` |
| P1 `04-sqlite-schema.md` | Unchanged: additive intent table; no historical backfill. | `9748143129974644C9B717ADB6665F899B058A83FBF361FA161F0EB60802BA83` |
| P1 `05-event-journal.md` | Unchanged: additive status event v1; existing event versions unchanged. | `03C519A5F91CC22CC7BFF3B32C68E7208C9E9035836F7E91CAE12C4949AEF07F` |
| P10 `00-contract-index.md` | Unchanged: points to source and rebuild owners. | `42A818DA0E84AAE4449A17A826F7E9C04E77988D0A0A25140189ABF3E9521EE9` |
| P10 `01-view-inventory.md` | Unchanged: no new view or ViewId. | `0D285BF329B309F9C89D34333150CC9F6E1254B31B2672499FD28D9A56EFF1EC` |
| P10 `02-attention-readmodel.md` | Amended: current P1 table is source truth; events and P12 hooks trigger source-only reconciliation, independent of shared offset. | `06439D3EA1774B6A6AF7DA574B79B17A33A41470E182A494D4D46A50B94DA700` |
| P10 `03-effectivefacts-freshness.md` | Amended: source reconciliation may become current despite generic offset refusal; ordinary event freshness remains unchanged. | `FB46B88A99F6DD4D07B22FB341AD39C125D3754E0774E90BCE48963BA73408C3` |
| P10 `04-rebuild-atscale.md` | Amended: generic refusal contract is unchanged; dedicated reconciliation is not a generic rebuild. | `E3D09302D01BFFB1417524570128965809CB404F14E76EE1ECE57D9BAE917635` |
| P10 `05-surface-actions-transport.md` | Amended: current-table source reconciliation and offset-independent P12 call. | `4E715EE27F6571BFF245CD40F999B8FD586F081232765BF0F03A1EF9A9E15D25` |
| P10 `07-acceptance.md` | Amended: separates below-floor direct reconciliation from full rebuild after pruning; adds Pending→Active race case. | `B5301A66BDA4C5CD6636515B3E68557D966C770EC891344EE0F79305016FCEE0` |
| P11 `10-ownership-wiring.md` | Unchanged: claim + Active CAS + event share one transaction. | `EF1BA6036083F6A8A9F67AA30E1268A0CD21C29B10E17D057AB65C04A429236E` |
| P12 `10-transport-shells.md` | Amended: post-commit and startup reconcile all intents, then retry Pending; no shared-offset mutation. | `4820E0E6610CE9F83A34C095D479FC000D8C64C0AA008EB0D34F1A15A9ED0B36` |

Top-level frozen System Design and DID were not changed. No production or test
file was changed and no test/gate was run for this documentation-only landing.
The earlier trigger-injected failure remains evidence of post-commit claim
failure only, not exact process-kill qualification. OPEN-3 still requires the
listed fresh-daemon, retention-floor, rebuild-race, and crash/replay tests
before implementation closure.
