# Native OS Sandbox Wave A — Provider-Neutral Runtime Boundary

**Baseline:** `af0aa80519116edd1fe092cb226103f17e07361d`
**Result:** Wave A contracts and the shell spawn boundary are implemented. This does not qualify or claim any OS-enforced provider.

## Changes

- Added domain-owned sandbox profile, network mode, boundary, provider status/capability and exact provider selection types. `decodeSandboxProviderId` canonicalizes the historical `LocalTrusted` spelling to `TrustedLocal` without selecting it; capability resolution matches only the immutable requested provider and rejects unsupported OS enforcement without fallback.
- Added `SandboxProcessPolicy` and `SandboxProcessPort` contracts. The policy binds execution/episode, current handle, exact mounts, provider/profile/network/digest, environment allow-list, resource limits and audit references. Process results distinguish completion from typed unavailability.
- Routed shell execution through a Runtime-owned callback and `SandboxProcessPort`. Runtime requires an exact policy/Execution/Episode/handle/mount binding, then checks provider capability before calling `run`; missing policy, unavailable service, mismatch, or an Experimental OS provider cannot spawn.
- Removed `node:child_process` from the shell executor. The architecture test rejects production child-process imports except the fixed P39 host-probe module. Added an environment projection helper that accepts the policy-owned allow-list for provider adapters.
- Updated direct shell tests to use a provider-port stub; shell policy tests no longer create OS processes.

## Verification

- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Focused Vitest: domain sandbox policy, P4 shell and P4 pipeline — 3 files / 97 tests PASS.
- Architecture boundary test — 1 file / 1 test PASS.
- Biome on the 12 changed TypeScript files — PASS.
- `git diff --check` — PASS.

No OS provider was implemented or qualified in this wave. Production shell invocation without an exact runtime policy/provider returns Unavailable and starts no process. T1 Waves B–D remain outstanding.
