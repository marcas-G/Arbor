# Arbor Functional Test Strategy

## Status

```text
Date: 2026-10-04
Scope: release-observable behavior
Initial implementation: COMPLETE
Release claim: NOT implied by unit/integration counts
```

## Why this layer exists

Arbor already has extensive Domain, repository, architecture and component
coverage. Those suites answer whether internal contracts behave as encoded;
they do not by themselves prove that a user can start the built product and
finish a task.

The previous S1–S4 process test was directionally correct but still read
SQLite to discover an approval and a Work. That made the test capable of
passing even if the public Inbox or Current Work projection was unusable. The
functional layer removes that privilege.

## Research basis

The implementation follows four observed practices:

1. OpenAI Codex's SDK harness launches the real app-server against an isolated
   temporary home/workspace and a local mock model server, then drives the
   public SDK rather than internal handlers:
   <https://github.com/openai/codex/blob/main/sdk/python/tests/app_server_harness.py>
2. Codex remote-executor qualification reuses the same integration scenarios
   across local and remote environments and requires explicit reasons for
   environment-specific skips:
   <https://github.com/openai/codex/blob/main/.codex/skills/remote-tests/SKILL.md>
3. Playwright creates a clean browser context per test and recommends traces
   for diagnosing failures:
   <https://playwright.dev/docs/browser-contexts>
   <https://playwright.dev/docs/trace-viewer>
4. A balanced test portfolio keeps many narrow tests but reserves a small
   number of broad-stack tests for externally observable requirements:
   <https://martinfowler.com/articles/practical-test-pyramid.html>

## Functional trust boundary

A test qualifies as an Arbor functional test only when all are true:

```text
production TypeScript build
production Web build
actual apps/single-workspace/dist/main.js OS process
fresh temporary cwd + database + workspace
provider reached through its HTTP protocol boundary
input through browser or public /commands
observation through browser or public /views
```

Forbidden as a success oracle:

- SQLite reads, SQL text or database adapters;
- `buildSingleWorkspaceLayer`, repositories, stores or handlers;
- direct Domain/Application command invocation;
- source-string presence as proof of product behavior;
- changing an expected result after observing the implementation;
- silent retries that turn a flaky failure into a pass.

Allowed diagnostic evidence after failure:

- bounded process stdout/stderr;
- Playwright trace and screenshot;
- captured provider-boundary requests;
- the isolated database retained manually for investigation.

Diagnostics cannot be the pass oracle.

## Test portfolio

| Layer | Purpose | Provider | Release blocking |
|---|---|---|---|
| Contract/unit | invariants and exact transition tables | fake/in-process | yes |
| Component/integration | capability wiring and failure branches | controlled | yes |
| Process functional | public API journey against built daemon | local HTTP stub | yes |
| Browser functional | real user interaction against production Web build | local HTTP stub | yes |
| Live-provider qualification | provider compatibility and model behavior | real deployment | separately gated |
| Exploratory dogfood | discover unknown product problems | real deployment | evidence input, not automation |

The deterministic provider is not used to judge model intelligence. It makes
the external model boundary reproducible so Arbor's own workflow can be tested.
The same provider adapter has independent conformance and live qualification.

## Oracle rules

Every journey starts with a user-visible Given/When/Then contract written
before implementation inspection. Examples:

- before approval, Current Work is visibly empty;
- a pending approval is discoverable through Inbox;
- after approval, Current Work visibly contains the requested objective;
- Verification PASS does not complete Work before Acceptance;
- after Acceptance, Current Work becomes empty;
- after a hard restart, the transcript/result remains and the provider is not
  called again;
- a browser user can create a project, send a message and see the authoritative
  answer without knowing an internal ID.

## Commands

```text
pnpm test:functional:process
pnpm test:functional:ui
pnpm test:functional
pnpm check:release
```

The browser suite keeps traces and screenshots only on failure. On Windows it
uses installed Edge; other environments install Chromium with:

```text
pnpm exec playwright install chromium
```

## Current limitations

- The browser suite covers project creation, conversation delivery, exact
  approval, PASS acceptance and restart persistence.
- Real-provider behavior remains opt-in and cannot replace deterministic
  release-functional tests.
- F20 clean packaged-checkout qualification passes from committed HEAD.
- F21 is blocked by an open product-design gap: UI CreateProject currently
  creates an empty ResourceBoundary, so a newly created project can chat but
  cannot perform evidence-producing file tools.
- F22 is blocked by a separate read-model gap: Completed Work disappears from
  its original Work page, so the user cannot inspect the terminal lifecycle.
