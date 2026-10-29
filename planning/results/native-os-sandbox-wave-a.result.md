# Native OS Sandbox Wave A — Provider-Neutral Runtime Boundary

**Baseline:** `af0aa80519116edd1fe092cb226103f17e07361d`
**Initial implementation:** `c947587df33a2caec7f5a898d2e7460c303a7c37`
**Review remediation:** recorded in the follow-up commit for this result.
**Result:** Wave A contracts and the shell spawn boundary are implemented. This does not qualify or claim any OS-enforced provider.

## Changes

- Added provider-neutral profile, trust boundary, capability and exact provider-version/revision selection contracts. `LocalTrusted` decodes only to canonical `TrustedLocal`; provider resolution never falls back.
- Added closed-field, canonical `NetworkPolicyV1` codecs for `Disabled`, `Restricted`, and `Enabled`, including exact hostname/IP-literal destination, protocol and port fields. Added a strict non-empty ExecutionEpisodeBinding codec and runtime revalidation.
- Expanded `SandboxProcessPolicy` to bind the exact Execution/Episode, handle/mounts, policy revision/digest, provider version/capability revision, network destinations, environment allow-list, resource limits and audit refs. Runtime validates these bindings and clamps requested timeout to the policy walltime.
- Added an explicit executor `processCapability` registration. Only registered process executors receive the Runtime-owned `SandboxProcessRunner`; Runtime rechecks exact provider version/capability before calling `SandboxProcessPort`.
- Removed direct process creation from the shell executor. A typed `SandboxProviderUnavailableOutcome` now crosses ToolRuntime, executable Application handling, AgentLoopAction, and `ExecutionDriveOutcome`, retaining the policy, episode, provider/version, evidence and failure binding for P9. P4 commits a no-effect `ExpectedFailure` settlement for the invocation before returning the typed result; Wave A does not persist the P9 fact.
- Replaced the text import scan with a TypeScript 7 compiler-scanner audit over the production `.ts/.tsx/.js/.jsx/.mjs/.cjs` inventory. It rejects static/dynamic/require/createRequire/subpath/native binding bypasses; the P39 allowance checks its exact `execFileSync` import, PowerShell argument template, timeout and registered call sites. Red fixtures cover static/dynamic imports, computed imports, require, createRequire, templates and native bindings.
- The architecture audit also rejects `worker_threads`, `vm`, `eval`, `Function`, Worker construction, native built-in module lookup and non-literal dynamic imports; it inspects every string and interpolated-template token for native-module fragments. The sole P39 process exception pins LF-normalized source SHA-256 `b15f80d7d462c5693beab86fbb121596480384264c263bf29a9ba736e5f0ee49` and exact `execFileSync(command, [...args], { ...options, env: environment })` call shape.
- Runtime rejection tests cover execution/episode/handle/mount binding and invalid timeouts, asserting no provider invocation for each mismatch.
- The environment projector accepts the exact policy allow-list; shell tests use a provider stub and do not create OS processes.

## Verification

- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Focused Vitest: domain sandbox policy, P4 shell/pipeline and Application executable outcome — 4 files / 125 tests PASS.
- Architecture boundary test — 1 file / 22 tests PASS.
- Biome on the 17 changed TypeScript files and the result record — PASS.
- `git diff --check` — PASS.

No OS provider was implemented or qualified in this wave. Missing/mismatched policy or execution/episode/handle/mount binding, unregistered process capability, unsupported provider, provider/version mismatch, or invalid timeout starts no process and cannot fall back to TrustedLocal. P9 fact/queue/event persistence is explicitly not implemented or closed in Wave A; it remains for Wave D after storage integration. T1 Waves B–D remain outstanding.
