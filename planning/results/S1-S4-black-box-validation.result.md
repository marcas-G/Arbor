# S1–S4 Scenario Black-box Validation

**Status:** PASS WITH ONE REAL-PROVIDER STABILITY GAP

**Date:** 2026-10-02

## Scope and boundary

The new deterministic suite starts the built production entrypoint
`apps/single-workspace/dist/main.js` in a separate process and uses only:

```text
public HTTP commands
public HTTP views
an external OpenAI-compatible SSE provider
process SIGKILL / restart
```

It does not read SQLite, import command handlers or mutate repositories.

Executable suite:

```text
C:/Arbor/tests/capability/black-box/s1-s4-public-api.test.ts
```

## Scenario results

| Scenario | Black-box evidence | Result |
|---|---|---|
| S1 normal progress | CreateProject, human conversation, AssignWork, CompletionClaim, independent Verification evidence/Pass, explicit Acceptance, CompleteWork | PASS |
| S2 supervision | public responsibility-tree observation and correctly shaped Normal SteerWork through `/commands` | PASS |
| S3 coordination | first-layer child Workspace with server-projected parent; real B06–B09 communication/delegation/dependency sentinels | PASS |
| S4 continuity | SIGKILL daemon, restart same DB, tree/Verification/Acceptance remain, completed Work causes zero provider replay | PASS |

Deterministic process suite:

```text
4/4 PASS
```

## Capability matrix validation

Gray-box baseline:

```text
root: 242/242 PASS
web:   34/34 PASS
```

Real-provider L3 stable PASS:

```text
B01 conversation
B02 executable tool observation
B03 control action
B04 cognitive continuity/isolation
B05 human steer reaches cognition
B06 parent/child communication
B07 responsibility delegation
B08 specialist delegation
B09 dependency declaration
B12 process restart continuation
B13 failure recovery
B14 web projection
```

`B10 Verification` is no longer blocked by a design gap. The deterministic
process black-box covers the complete Verification/Acceptance path, and prior
live DeepSeek dogfood proved exact evidence + durable summary + verifier
settlement. A standalone B10-only three-run REAL sentinel is still NOT_RUN.

`B11 Completion / Acceptance` is the only unstable real-provider capability;
see:

```text
C:/Arbor/planning/gaps/BLACKBOX-GAP-01-real-provider-completion-claim-instability.md
```

## Defects found and corrected in the test system

1. The real-provider test client dropped ToolCall/ToolResult/ControlResult when
   translating PortableModelRequest; it now emits proper assistant/tool pairs.
2. `--repeats 3` executed four total runs under Vitest; it now uses two repeats
   for exactly three runs.
3. B05 used an obsolete flat SteerWork payload; it now uses the frozen
   `steer + provenance` shape.
4. B04/B06 fixtures claimed overlapping or invalid resource regions; fixtures
   now use non-overlapping FileTree roots / empty child boundary as appropriate.
5. B12 spawned from the repository root and accidentally consumed the user's
   local `arbor.config.json`; it now starts in its isolated directory.
6. External `AcceptWorkOutcome` authority resolution did not derive the target
   Workspace from canonical Work facts; this production defect was corrected.

## Final mechanical regression

```text
pnpm check PASS
architecture: 121/121
core: 1552 pass / 1 skip
web: 212/212
lint / typecheck / build: PASS
```

## Evidence reports

```text
C:/Arbor/planning/testing/core-capability/reports/capability-gray-box-2026-10-02T10-09-05.650Z-1bbd310a-b741-4231-8886-1c7e20bee82e.json
C:/Arbor/planning/testing/core-capability/reports/capability-real-provider-2026-10-02T10-11-29.268Z-018bb3fb-e8b6-4ecd-987c-4a6dd679f94c.json
C:/Arbor/planning/testing/core-capability/reports/capability-real-provider-2026-10-02T11-07-15.734Z-89da0cfa-7f28-4045-9724-0b8a844bb9ff.json
C:/Arbor/planning/testing/core-capability/reports/capability-real-provider-2026-10-02T11-29-21.885Z-e3b4f8bb-33b6-45b5-8a89-a654f6674c9d.json
```
