# Native OS Sandbox POSIX provider bring-up (T2/T3)

**Baseline:** `fe74e07d`

**Authorization:** `AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION`
**Scope:** experimental Linux bubblewrap and macOS Seatbelt capability adapters,
closed policy generators, capability registration, and focused qualification.
No `docs/design/**`, migration, database, package installation, or release
changes.

## Delivered

- Added `@arbor/sandbox-native-posix` with provider ids `linux-bwrap` and
  `macos-seatbelt`. Both providers are capability-only in production
  composition. Their status is never `Supported`; the existing resolver rejects
  `Experimental` for `OsEnforced` policy selection.
- Linux probing records bwrap, user/mount/PID/network namespace, cgroup-v2
  pids/memory/cpu, seccomp, broker-channel, and process-group cleanup evidence.
  It runs only bounded, fixed `bwrap` capability probes. Missing mandatory
  isolation or resource primitives yields `Unavailable`; absent broker support
  leaves only network `Disabled` available.
- The bubblewrap plan uses a fresh root, exact admitted mounts, isolated
  user/PID/network namespaces, closed cwd mapping, cleared/projected
  environment, and carries the exact policy limits. Absolute executable and
  cwd paths must resolve inside admitted roots; path traversal and symlink
  escapes fail closed.
- macOS Seatbelt generation is deny-default, allows read/write access only
  under exact admitted roots, permits the pinned executable, and denies
  networking. Its prerequisite probe requires Seatbelt, process-group cleanup,
  and an rlimit helper; other platforms return typed `Unavailable`.
- Restricted/Enabled networking is unavailable without a broker. The provider
  `run` path returns typed `Unavailable` even when prerequisites probe as
  Experimental: per-execution cgroup/rlimit enforcement and safe child-tree
  launch/cleanup are not yet implemented, so no untrusted process is spawned.
  There is no TrustedLocal fallback.

## Host probe

The host is Windows (`win32`). WSL listed `Ubuntu-22.04` and `Ubuntu`; both
reported `Linux` and `BWRAP_MISSING` from `command -v bwrap`. No package was
installed. The native Windows adapter therefore reports the POSIX providers
Unavailable for unsupported platform; the Linux missing-bwrap path is covered
by a deterministic probe test.

## Qualification

- Adapter tests: 13/13 PASS, covering namespace probe evidence, missing
  primitives, policy argv/profile generation, mount and symlink escape,
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

T2 policy/probe bring-up is complete at Experimental/Unavailable status. T3
network and resource conformance is **OPEN**: neither provider can execute a
process until the broker and race-safe per-execution resource/process-tree
controls are available and qualified. No Supported or release claim is made.
