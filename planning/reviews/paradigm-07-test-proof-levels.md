# Test Proof Levels

Every test claim must identify the level of behavior it proves. The repository
layout is the default label; a test that crosses a boundary must use the
higher-level label.

| Level | Default location | What it may claim | What it cannot claim |
|---|---|---|---|
| Pure | `packages/*/test` for dependency-free functions | deterministic transformation, ADT transition, projection | persistence, process restart, public HTTP behavior |
| Port | `adapters/*/test`, port contract tests | adapter/port contract, codec, SQL mapping | application lifecycle or user-visible flow |
| Application | `packages/application/test`, `tests/p1-*` through `tests/p10-*` | command transaction, authority, idempotency, consumer behavior | daemon crash/restart unless explicitly injected |
| Process | `tests/functional/process`, `tests/functional/pending` | real daemon, SQLite, lease, restart, crash window | public browser layout |
| Public | `tests/capability/black-box`, `tests/functional/ui` | public HTTP/browser/user journey | internal repository facts as the only oracle |

## Review rule

The result record must name the level. A lower-level test can support a
higher-level claim only as a prerequisite, never as the acceptance evidence
itself.

## Current exceptions

Historical phase tests remain where they are for replay and evidence. New
tests should follow the table; moving old tests is not required for this
phase.
