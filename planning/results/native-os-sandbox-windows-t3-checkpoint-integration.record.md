# Windows Native Sandbox T3 Test and Artifact Checkpoints — Integration

**Date:** 2026-10-19

**Unified base:** `beaedaf1`.

**Integrated source commits:** `4ab3c5ec`, `e9d18a52`, `5b0b4c02`, `7737217a`, `cede0b02`, `81663a4e`, `25ef2d75`, cherry-picked in that order as `20b70fad`, `7ee47f05`, `9819f852`, `4267cd04`, `aeb1cb4f`, `39f41e2f`, `a2b89798`. The cherry-picks had no textual conflicts. The only integration edit to Windows adapter code sorts the exported artifact names for Biome.

## Scope and limits

The checkpoints add disposable native AppContainer/Job/ACL/network test probes, a fixed adapter-owned C# source artifact, and read-only artifact inspection with fail-closed I/O handling. The native harness and artifact contract do not connect to `SandboxProcessPort.run`; no helper EXE is shipped. All Windows provider entries remain `Experimental`, advertise empty profile/network tuples, and return typed `Unavailable`. No row is marked Supported, and the current D0/D3 full rule-set digest and qualification evidence requirements remain in force. The checkpoints do not qualify exact Disabled direct-network denial, a lifetime-safe filesystem boundary, Restricted/Enabled broker behavior, signed helper provenance, production process launch, or release. Detailed test observations and limits remain in the three source checkpoint results and `planning/tasks/native-os-sandbox-windows-t3d.md`.

The read-only independent task `/root/windows_t3a_review_sol` reported scoped B0/B1/B2 = 0 after the `e9d18a52` Job-limit follow-up (native/provider 8 and architecture 39), after the `5b0b4c02` T3-B checkpoint (native/provider 12/12 and architecture 39), and after the `81663a4e` T3-C typed-I/O fix (artifact/provider 9 plus TypeScript/Biome). These are thread-local checkpoint reviews; no separate repository review artifact or hash was supplied. They do not close the full T3 provider or release qualification.

## Integrated checks

- `pnpm build` and `pnpm typecheck`: PASS.
- Windows native bridge, artifact and provider: PASS, 19/19.
- D0 domain policy/codec, process-policy materializer and P4 pipeline: PASS, 104/104.
- `pnpm architecture`: PASS, 192/192.
- `pnpm lint`: PASS, Biome 1,318 files; no fixes applied.
- `git diff --check`: PASS for both the integrated commit range and final working changes.

No `docs/design/**`, schema, migration, database, production run route, provider qualification, or release artifact changed in this integration.
