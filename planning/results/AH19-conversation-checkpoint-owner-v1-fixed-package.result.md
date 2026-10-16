# AH19 Conversation Checkpoint Owner — Fixed Package Record

Status: **PROPOSED FOR MANUAL GOVERNANCE; NOT ACCEPTED.** Planning-only
artifact. No `docs/design/**`, production, test, or migration file was changed.

## Package identity

- Base HEAD: `367fd9a3d064409b77b03bcab4ba26703d0a32b8`.
- Proposal: `planning/proposals/AH19-conversation-checkpoint-owner-v1-fixed-package.md`.
- Raw proposal SHA-256: `9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
- Recommended manual token: `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`.
- Production implementation requires a separate authorization token after
  design landing; no implementation token is requested or implied here.

## Fixed decision

The proposed v1 owner is the exact Root `WorkspaceId`, stable across messages,
response jobs, attempts, and executions. A checkpoint covers a contiguous FIFO
prefix of Answered HumanMessages. The currently Claimed message remains exact,
pinned, and present once; it is not covered until its response is Answered.
Checkpoint use is isolated from the Workspace Work Session. ProviderNative
reuse requires an exact complete model binding; otherwise portable Summary
rebuilds from retained HumanMessage source. HumanMessages and live summary/blob
references remain durable across restart.

The process matrix includes a separate fail-closed negative for an earlier
Pending, Claimed, or RetryScheduled message between the Answered prefix and a
later Answered message. Frontier coverage must stop at the continuous Answered
prefix and remain stopped after restart; the Claimed body remains pinned once.

The recommended physical boundary is a distinct owner-scoped Conversation
checkpoint state, with an additive migration ID chosen only by the subsequent
implementation package. The fixed package reserves no migration ID, does not
backfill ownership from existing Session checkpoints, and does not authorize
store, runtime, or test changes.

## Verification and boundary

- Raw SHA-256 was computed over the saved proposal bytes.
- Whitespace check: `git diff --no-index --check -- /dev/null <new-file>`
  reported no whitespace errors. Exit code 1 is expected because each new file
  differs from `/dev/null`; Git emitted only its configured LF-to-CRLF
  normalization advisory.
- No tests or builds were run; no files were staged or committed.
- This result records the fixed package, not its acceptance or implementation.
