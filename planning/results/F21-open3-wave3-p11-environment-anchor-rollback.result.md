# F21 OPEN-3 Wave3 — P11 environment anchor rollback qualification

Date: 2026-10-10

Base: `df8def61ac71b2c06f6d04fbbe79ccddffde6308`

Status: **The P11 Active-event append-failure test now proves the environment
revision anchor rolls back with the claim, intent CAS and event transaction.
F21 OPEN-3 remains open.**

## Verification

`adapters/persistence-sqlite/test/ownership.test.ts` now records the
`EnvironmentRevisionStore.current(projectId)` result immediately before and
after the injected `DomainEventJournal.append` failure. Both are `None`; the
Pending intent remains Pending, `activatedAt` stays null, active claims remain
empty, and no `WorkspaceResourceActivationChanged(Active)` event is committed.
The same unit file also asserts no anchor appears when a caller supplies a
boundary that does not match the persisted Workspace.

```text
Vitest: adapters/persistence-sqlite/test/ownership.test.ts  8/8 PASS
pnpm typecheck                                               PASS
```

This closes only the specific anchor rollback evidence item; it is not a
broader P11 or F21 OPEN-3 closure claim. No production code changed and no full
`pnpm check` or functional suite was run.
