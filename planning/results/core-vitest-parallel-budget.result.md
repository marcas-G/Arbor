# Root core Vitest worker budget

Date: 2026-10-16
A/B base: `c4154319`; one-worker preference confirmed on `95301852`.

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

The earlier two-worker resource sample had less virtual-memory headroom than
the one-worker sample; no comparable resource data was supplied for the later
green run. Per the user's explicit priority, this host's reliability takes
precedence over suite duration; performance optimization is deferred. No
further A/B run is planned for this change.

## Machine context and verification boundary

The current Windows host reports Windows 10 IoT Enterprise LTSC, Intel Core
**i7-6500U (2 cores / 4 logical processors)**, 15.9 GB physical memory, Node
v24.21.0, and pnpm 12.4.2. Memory/headroom values above are the recorded
aggregate process/OS observations supplied with the A/B runs; no new full core
run was performed for this configuration-only change.

Targeted architecture/config guard, typecheck, Biome, and diff checks are
recorded with the landing commit. Functional, architecture, and Web Vitest
worker budgets remain untouched.
