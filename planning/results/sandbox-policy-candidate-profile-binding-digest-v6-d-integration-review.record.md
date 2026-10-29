# Sandbox Policy Candidate Profile Binding Digest V6-D — Integration Review

**Date:** 2026-10-19

**Integrated source:** `4aeac3de` cherry-picked as `d168e9de` after the Windows T3 checkpoints, with no textual conflict.

**Independent review:** `/root/native_sandbox_wave_d_review` reviewed V6-D read-only and reported B0 = 0, B1 = 0, B2 = 0. Reported focused evidence was 47/47 Web tests plus Web typecheck and build. This review closes only the Web selection slice; V6-E/F remain open.

The existing Workspace Detail candidate read now drives a deliberate Human selection. The Web mapper sends the selected candidate's digest and the current common preconditions through the existing P1 command; OsEnforced alone supplies provider/registry fields and a Human network policy. TrustedLocal requires separate high-risk confirmation and uses FullAccess/Unconfined. A stale receipt invalidates the old read and requires another explicit selection, even when candidate ID is unchanged. The candidate ID is presentation-only and never enters P1. No default choice, automatic retry/fallback, new command, endpoint, schema or migration is introduced.

## Integrated checks

- Web catalog, forms, candidate mapper and Workspace page/reselection: PASS, 47/47.
- `pnpm --filter @arbor/web typecheck`: PASS.
- `pnpm --filter @arbor/web build`: PASS; Vite reports its existing >500 kB chunk advisory.
- `pnpm lint`: PASS, Biome 1,318 files; no fixes applied.
- `git diff --check`: PASS for both the integrated commit range and final working changes.

P1 stale-field qualification, real SQLite dual-daemon recovery, broader V5/V6 gates, provider qualification and release are not claimed.
