# Native OS Sandbox POSIX provider bring-up (T2/T3)

**Baseline:** `fe74e07d`

**Authorization:** `AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION`
**Scope:** experimental Linux bubblewrap and macOS Seatbelt capability adapters,
closed policy generators, prerequisite detection, capability registration,
and focused contract tests.
No `docs/design/**`, migration, database, package installation, or release
changes.

## Delivered

- Added `@arbor/sandbox-native-posix` with provider ids `linux-bwrap` and
  `macos-seatbelt`. Both providers are capability-only in production
  composition. Their status is never `Supported`; the existing resolver rejects
  `Experimental` for `OsEnforced` policy selection.
- Linux probing records only `PrerequisiteDetected` or `Unavailable` for the
  bwrap executable, fixed namespace probes, cgroup-v2 hierarchy/controller
  listings, seccomp interface, broker channel and `process.kill` API. These
  observations do not establish effective filesystem/network isolation,
  process-tree cleanup, or resource control. The capability remains
  `Experimental` with empty profile and network-mode lists on every host.
- The bubblewrap plan uses a fresh root, exact admitted mounts, isolated
  user/PID/network namespaces, closed cwd mapping, cleared/projected
  environment, and carries the requested policy limits. Absolute executable
  and cwd paths must resolve inside admitted roots; path traversal and symlink
  escapes fail closed. The generated plan does not enforce those limits.
- macOS Seatbelt generation is deny-default, allows read/write access only
  under exact admitted roots, permits the pinned executable, and denies
  networking. Its probe records only whether `sandbox-exec`, the
  `process.kill` API and the configured rlimit helper path are present. It does
  not qualify process-group cleanup or rlimit enforcement. Other platforms
  retain `Experimental` status with empty tuples and typed unavailable runs.
- Restricted/Enabled networking is unavailable without a broker. The provider
  `run` path returns typed `Unavailable` even when prerequisites probe as
  Experimental: per-execution cgroup/rlimit enforcement and safe child-tree
  launch/cleanup are not yet implemented, so no untrusted process is spawned.
  There is no TrustedLocal fallback.

## Host probe

The host is Windows (`win32`). WSL listed `Ubuntu-22.04` and `Ubuntu`; both
reported `Linux` and `BWRAP_MISSING` from `command -v bwrap`. No package was
installed. The native Windows adapter reports `Experimental` capability rows
with empty tuples and `UnsupportedPlatform` failure codes. The Linux
missing-bwrap path is covered by a deterministic probe test that reports an
unavailable prerequisite.

## Verification

- Adapter tests: 13/13 PASS, covering namespace prerequisite detection, missing
  prerequisites, policy argv/profile generation, mount and symlink escape,
  environment projection, limits, network denial, and no-spawn Experimental
  behavior.
- Focused P4/P11/P12/harness tests: 36/36 PASS.
- Focused architecture tests: 40/40 PASS, including the audited fixed bwrap
  probe-call exception.
- Latest architecture rerun after the probe-template tightening: 22/22 PASS.
- `pnpm --filter @arbor/sandbox-native-posix... build` — PASS.
- `pnpm --filter @arbor/single-workspace build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Changed-file Biome and `git diff --check` — PASS.
- Full `pnpm check` and `pnpm test:functional` were not run, per task scope.

The adapters remain `Experimental` and publish no executable profile/network
tuples. Their `run` methods return typed `Unavailable`, including when all
prerequisite markers are detected. T3 network and resource conformance is
**OPEN**; no process-tree cleanup, resource-control qualification, Supported
status, or release claim is made.
