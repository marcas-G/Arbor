# Functional Test Foundation Result

**Date:** 2026-10-04
**Status:** FOUNDATION COMPLETE / RELEASE VALIDATION STILL OPEN

## Outcome

Arbor now has a separately runnable functional layer that verifies the built
product from public boundaries rather than treating internal state as proof.

```text
production daemon build
+ production Web build
+ real OS child process
+ fresh temp cwd/database/workspace
+ HTTP model boundary
+ public API or real browser input
+ public View or visible DOM oracle
```

## Corrected false-black-box behavior

`tests/capability/black-box/s1-s4-public-api.test.ts` previously queried
SQLite directly to discover:

- the pending ActionApproval;
- the created Work and its internal fields.

Those reads have been removed. The journey now:

- discovers approval only through `inbox-view`;
- proves zero pre-approval mutation through `current-work === null`;
- obtains Work identity/objective/state only through `current-work`;
- observes Verification and Acceptance through public Views;
- uses provider-boundary capture only to prove that a user prohibition reached
  the next model context.

An architecture test fails if SQL, SQLite, stores, composition internals or
known internal approval tables return to the functional journey.

## Browser journey

Playwright now proves one genuine user journey against production artifacts:

```text
open fresh Arbor
→ create Project in the UI
→ land on /p/:projectId
→ send a message from the Root conversation
→ see authoritative Human and Arbor turns
→ hard-restart the daemon
→ reload the browser
→ see the same turns
→ observe zero duplicate provider request
```

The browser test never calls `/commands` or `/views` directly. Failures retain
a Playwright trace and screenshot. Retries are disabled.

## Commands

```text
pnpm test:functional:process
pnpm test:functional:ui
pnpm test:functional
pnpm check:release
```

## Verification

```text
pnpm test:functional
  process functional     4 / 4 PASS
  browser functional     1 / 1 PASS

pnpm check
  Biome                 893 files PASS
  TypeScript            PASS
  Architecture           30 files / 154 tests PASS
  Core                   307 files / 1671 passed / 3 skipped
  Web typecheck          PASS
  Web build              PASS (existing >500 KB warning)
  Web                     31 files / 216 tests PASS
```

## Honest boundary

This result does not claim release readiness. It establishes trustworthy test
mechanics and the first five release-functional cases. The next blocking
journeys are F10–F20 in:

```text
planning/testing/functional/01-functional-journey-catalog.md
```

Highest priority: browser approval without copying IDs; Fail/Unknown
Verification behavior; provider outage recovery; crash after provider success;
third-page conversation history; packaged clean-checkout smoke.
