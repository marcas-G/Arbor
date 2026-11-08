# PP-W402 — Work Admission Handoff Governance Draft

Status: DRAFT — manual governance required.

## Question

What durable fact connects `AssignWork committed` to the scheduler's exact
`WorkEpisode` admission, including RootConversation failure and process
restart?

## Required decisions

- admission intent identity and target Work revision;
- scheduler successor identity and duplicate delivery rule;
- current-work selection/fencing behavior;
- RootConversation failure after Work creation;
- stale approval/receipt handling;
- public state while the Work is waiting for admission.

## Acceptance evidence

The accepted contract must prove one exact Work is admitted once after normal
success, RootConversation crash after commit, daemon restart before dispatch,
lease takeover during admission, and duplicate wake/receipt delivery.

No implementation or migration is authorized by this draft.
