# P37 L2 + L3 Integrated Implementation Checkpoint

Date: 2026-10-11
Status: **Implementation checkpoint only; tests and P37 qualification not run**

## Baseline and integration

- Integration worktree: `C:\Users\ThinkPad\.codex\worktrees\p37-l2-l3-integration\Arbor`
- Exact base: P36 qualified and pushed checkpoint `ba0e295b304cc89510910de44e7ee222a85b680c`.
- L2 source: `eeac800992e9f1cd4db9b0cbf85e1d15a53ee02d`.
- L3 source: `4726eddcb4298bc719c4118c4c7f1fc7bc27996b`.
- L2 and L3 source histories share ancestor `9d45463b0c2b2296628fa80d33aa2a79a570da89`, not the P36 qualified base. Their scoped implementation commits were cherry-picked in order onto the exact P36 base. The resulting history preserves P36 qualification/review records and its two repaired tests; no P36 source change was reverted.
- Combined checkpoint: `fbcdc486725558cd8d9d4c399d8e363b34bf7ece` (subsequently amended for export ordering and this result record; see final HEAD).

## Integrated scope

- Migration 0037 is appended after the unchanged `P36_MIGRATIONS`/0036 prefix. It adds durable DeliverReplay P9 facts/outbox, P10 markers, and global Attention poll state.
- L2 adds raw P1 journal reads and Deliver-specific fact-first classification, the P9 fact/queue adapter, the P10 marker adapter, the fenced attempt-fair poll coordinator, and production poll wiring.
- L3 registers `DeliverMessage/1` through the Gateway and routes production Deliver AgentActions through `deliverMessageGatewayHandler`. The handler derives the direct-parent recipient and commits Message, MessageSent, Inbox admission, and receipt in the Gateway transaction.
- L4 receipt-first takeover is not in this checkpoint. In particular, `DeliverActionDependencies` does not yet carry `commandReceipts`, `commandHandlerRegistry`, `inbox.findByKey`, or the replay-fact dependency needed by that recovery path.
- `docs/design/**` and migration bodies 0034–0036 are unchanged. P36 qualification artifacts and the accepted v1.43/v6 governance record/review remain present.

## Static verification

- `pnpm typecheck` — PASS after adding the new raw-journal and DeliverReplay methods to existing test fakes. This runs `tsc -b` and `tsc -p tsconfig.test.json`; it does not execute tests.
- `pnpm exec biome check` over the 44 changed TypeScript files — PASS after sorting the new persistence exports.
- `git diff --check` against P36 base — PASS.
- No Vitest, public-process, browser, or full functional tests were run on the combined tree, following the user's test-window instruction.

## Inherited source-branch evidence and limits

The L2 and L3 source result records report their own isolated targeted build/test evidence. That evidence does not qualify the combined tree against the P36 checkpoint and is not restated as integrated test evidence here. The combined tree still requires the centrally scheduled functional qualification.

Open work passed to the next qualification layers:

- **L4:** receipt-first takeover for DeliverMessage, exact legacy direct-write proof/adoption, and recovery blocking/Attention fact behavior.
- **L5:** public P10 Attention projection, queue marker-before-ACK, exact wake/rebuild and same-transaction poll behavior under the integrated P36+P37 tree.
- **L6:** real multi-process lease/claim, crash/restart and attempt-fairness matrix, plus ordered upgrade and P12 capacity evidence. The v6 post-landing review's two nonblocking clarifications (retryable poll/store error versus lease expiry; P9 durable fact/marker population in `maxDbSize`) remain open follow-ups.

This checkpoint does not claim P37, AH10, migration 0037 deployment, or release closure.
