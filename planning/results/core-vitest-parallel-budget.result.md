# Root core Vitest worker budget

Date: 2026-10-16
A/B base: `c4154319`; corrected two-worker confirmation: `953018520b55cd78222c529d4fcc882b2f91f15b`.
Current review baseline: `ce4b1ccd39d89ca42ea59e496831bd7d993e8f9d`.

## Decision

Set `test.maxWorkers` to `1` in the root `vitest.config.ts`. This is the
configuration loaded by the root `pnpm test` script (`vitest run`); architecture,
functional, and Web tests use separate commands/configurations and are unchanged.
The architecture suite imports the root config object and asserts both the
default `pnpm test` entrypoint and its single explicit one-worker budget,
preventing an accidental return to Vitest's machine-default/unbounded worker
selection.

No timeout, retry, assertion, or test selection was changed.

## A/B evidence

The core suite was measured on `c4154319` with existing test assertions:

| Root core workers | Result | Elapsed | Peak aggregate private memory | Lowest observed OS virtual-memory headroom |
|---:|---|---:|---:|---:|
| default (3-worker behavior observed) | worker low-heap OOM | — | — | — |
| 1 | 372/372 pass, no OOM | 51m19s | ~1.89 GB | ~1.29 GB |
| 2 | 36m30s run: no OOM, six then-current schema-fixture failures | 36m30s | ~2.02 GB | ~394 MB |
| 2 | corrected current suite: 373/373 pass; no new resource sample in this handoff | — | — | — |

The corrected two-worker 373/373 confirmation was run at exact HEAD
`953018520b55cd78222c529d4fcc882b2f91f15b` using ordinary `pnpm test` (the
root script's plain `vitest run`, without a worker override). That run had no
new memory telemetry. It establishes the corrected suite was green at two
workers, but does not establish comparable resource use and must not be
compared as a memory sample against the `c4154319` A/B measurements above.

The earlier two-worker resource sample had less virtual-memory headroom than
the one-worker sample; no comparable resource data was supplied for the later
green run. Subsequently, the user selected `maxWorkers: 1` in commit
`4d6147a4` as a reliability policy for the weak host, despite the corrected
two-worker green result; performance optimization is deferred and no further
A/B is planned. The current review baseline is `ce4b1ccd39d89ca42ea59e496831bd7d993e8f9d`,
so final-gate status must be established on that exact HEAD before making any
current validation claim.

## Machine context and verification boundary

The current Windows host reports Windows 10 IoT Enterprise LTSC, Intel Core
**i7-6500U (2 cores / 4 logical processors)**, 15.9 GB physical memory, Node
v24.21.0, and pnpm 12.4.2. Memory/headroom values above are the recorded
aggregate process/OS observations supplied with the A/B runs; no new full core
run was performed for this configuration-only change.

Targeted architecture/config guard, typecheck, Biome, and diff checks are
recorded with the landing commit. Functional, architecture, and Web Vitest
worker budgets remain untouched.
