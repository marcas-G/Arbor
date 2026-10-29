# L3 Capability Progress — 2026-09-28

**Baseline:** `master@bc290b7` (+ governance `f82b422`); provider =
DeepSeek `deepseek-flash` via `capability.config.json` (env-overridable).

## Current L3 scoreboard

| Capability | L3 | State |
|---|---|---|
| B01 Basic Human Conversation | **PASS** | 3-run stability oracle green (2026-09-28 evidence) |
| B04 Multi-turn Memory | **PASS** | same-root recall + unrelated-root isolation green |
| B02 Executable Tool Use | FAIL (near) | route executes durably end-to-end (list/shell settle Success); remaining gap = **observation return**: Observation session entries exist but the next provider request does not carry them |
| B03 Control Action | FAIL (near) | model invokes arbor_wait; remaining gap = **work_waits row not written** (settle path not reached — same observation-return wiring suspect) |
| B05 Human Steer | FAIL (expected) | durable half passes; steer-to-cognition promotion unimplemented (sentinel documents the full oracle) |
| B06–B09, B11 | BLOCKED → **AUTHORIZED** | DID v1.19 ACR-6 unblocks implementation; sentinel specs ready in `12-l3-blocked-specifications.md` |
| B10 Verification | **PASS** | G-V2-2/3/4 closed by accepted DID v1.26 VDC; repeatable B10-only real-provider sentinel extracted and green |
| B12 Restart / Continuation | FAIL (harness verified) | spawn/SIGKILL/restart mechanics work; attribution oracle refined (history replay ≠ side effect); needs a rerun after the observation-return fix |
| B13 Failure Recovery | FAIL (near) | injected fault + recovery verified in probe; needs rerun |
| B14 Web Projection | FAIL (near) | pagination oracle rewritten on messageId; needs rerun |

## Known remaining work (ordered)

1. **Observation-return wiring** (`packages/agent-runtime` driver /
   model-context prepare): fold Observation session entries into the next
   turn's conversation messages. Unblocks B02/B03 (and improves B12/B14).
2. Rerun `B05,B12,B13,B14` sentinels after (1).
3. B06–B11 implementation under DID v1.19 ACR-6..8 (Wave 2 scope =
   `51-agent-control-module-map` sequenced by `52` DAG).

## Harness fixes landed this session (bc290b7)

- single layer build per handle (SQLite cross-writer deadlock)
- ToolInvocationId sha256 hex tail (real-provider call refs)
- stability oracle counts per-repetition evidence files (1+3 runs)
- provider config file + env override + apiKeyVar
- fixture resource boundaries (FileTree/GitWorktree)

## Push status

Local `master` = `cba5c91` (merge of remote line, ours strategy — remote
tree identical to `64997ad`, no new content). **Push blocked**: GitHub
token invalid over HTTPS; SSH times out. Awaiting credentials.
