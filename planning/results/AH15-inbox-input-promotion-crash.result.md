# AH15 Inbox input promotion — process crash qualification

Status: **PASS for the Inbox Session-append/consumption transaction boundary; AH15 is not a phase closure claim.**

Test: `tests/functional/process/ah15-inbox-input-promotion-crash.functional.test.ts`

The test uses the public production daemon composition and public child-Work
setup. A real `SendMessage(Query)` creates one canonical MessageId and Message
Inbox entry; the Scheduler forms the corresponding InboxEpisode before the
promotion transaction. A process-local, test-only probe pauses at two sides of
the single atomic transaction in `InputPromotionService`:

| Boundary | Independently readable state before hard kill |
|---|---|
| `AH15BeforeInboxPromotionCommit` | Message and Inbox row already exist; Inbox is unconsumed; the transaction's Session `UserMessage` append and consumed update are not visible. |
| `AH15AfterInboxPromotionCommit` | Same MessageId/entryKey; one sourced Session `UserMessage` exists and Inbox is consumed. |

At both probe points, an independent read-only snapshot joins the exact
`InboxEpisode` (`episode_ref = msg:<MessageId>`) to its `execution_id` and
asserts there is no ProviderTurn or ProviderAttempt for that execution. This
guards against model inference occurring before the Inbox input promotion
boundary. Provider Runtime persists the Attempt before invoking ProviderPort;
after restart the same InboxEpisode has one successful ProviderTurn/Attempt.

After `SIGKILL`, each case restarts the ordinary production daemon against the
same isolated SQLite database. Both converge to the same InboxEpisode and
MessageId, exactly one `MessageSent`, one Inbox row, one `UserMessage` sourced
from `InboxEntry` with `source_ref = msg:<MessageId>`, and `consumed_at != NULL`.
The child Work's original send-message decision is requested/emitted once, and
the target InboxEpisode has one post-restart Provider request, so its input is
not reprocessed into a duplicate model output. No shared
production behavior is changed when the optional test probe is absent.

## Verification

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah15-inbox-input-promotion-crash.functional.test.ts
Test Files: 1 passed; Tests: 2 passed (before/after commit)
pnpm typecheck: PASS
pnpm exec biome check <four changed source/test files>: PASS
git diff --check: PASS
```

Integration rerun at working source `021b6bf` plus this batch, after
`pnpm build`: the same dedicated process file passed again, 1 file / 2 tests
(before/after commit; latest rerun 69.64s). `pnpm build` passed before the rerun. This remains
AH15 boundary evidence only; AH16–AH19 and SCRC-008 are not inferred.

Final integrated `pnpm check` passes: Biome 953 files, typecheck, architecture
155, core 316 files / 1723 passed / 3 skipped, Web typecheck/build and 31 files /
216 tests. P12 restore-drill generated-field drift from the check was restored
to the committed timestamp and hash.

This result covers the actual atomic boundary and its before/after process
recovery; it does not establish all AH15–AH19 qualification or SCRC closure.
