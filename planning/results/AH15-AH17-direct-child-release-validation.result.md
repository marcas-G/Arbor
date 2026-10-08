# AH15 / AH17 / Direct-child AH10 — committed release validation

Commit: `cacbf942852de6ab1e91641009deae1132f17c0a` (`cacbf94`)
Branch: `codex/functional-tests`
Remote: `origin/codex/functional-tests` points to the same commit.

The commit was tested as a clean committed checkout, then through the full
functional suite. No source or test code changed after this commit.

## F20 clean committed checkout

Command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/package/clean-checkout.functional.test.ts --reporter=dot
```

Result: 1 file / 1 test PASS (50.65s). F20 cloned the committed `HEAD`, ran
frozen offline install, built the daemon and Web client, then passed the S1–S4
public black-box journey.

## Full functional suite

Command:

```text
pnpm test:functional
```

Result: PASS. Vitest completed 29/29 files and 71/71 tests (2238.69s); Playwright
completed 2/2 tests (25.0s). The full suite includes F20 (clean-checkout case
passed 1/1), AH15 Inbox promotion process-crash 2/2, AH17 Summary
checkpoint/epoch process-crash 2/2, and Direct-child AssignWork process
takeover 2/2. The explicit F20 run above is separate evidence on the same
commit.

The full functional result does not close AH10 overall, AH18, AH19 or SCRC-008.
AH10 remains PARTIAL. AH18 still lacks the link-present / Summary-turn
NotFound-or-Unsettled process-recovery case and second-terminal-overflow crash
qualification. AH19 ProviderNative match/mismatch portable rebuild and Native
checkpoint recovery remain open.
