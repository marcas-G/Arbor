# Sandbox Policy Candidate Profile Binding Digest V6 — Slice D

Status: **V6-D Web selection implemented**. This closes only the Web selection
slice; it does not qualify P1 stale-field behavior, SQLite dual-daemon
recovery, or overall V5/V6 closure.

## Implemented

- Added `DecideSandboxPolicy` to the existing Human-actionable Web catalog and
  added a strict local form-state schema for candidate identity, expiry,
  destinations, and TrustedLocal confirmation.
- Workspace Detail now presents available candidates without displaying
  candidate digests, binding data, or candidate IDs. The actual Workspace page
  requires a deliberate radio selection; nothing is selected by default.
- Added a pure mapper to the existing P1 payload. It copies only the selected
  candidate digest and common preconditions; OS candidates alone add their
  registry pair, provider/profile and human-supplied NetworkPolicy. TrustedLocal
  maps to exact FullAccess/Unconfined, sends no registry fields, and requires
  separate explicit high-risk confirmation. No candidate ID reaches P1.
- A `StaleSandboxPolicyInputs` receipt clears/hides the old read and invalidates
  the existing Workspace Detail query. When refreshed data arrives, the form
  remounts with no selection—even if `candidateId` is unchanged—and requires a
  new human choice. There is no automatic retry or fallback. Transport retry
  continues to use the existing held CommandId behavior.

## Verification

- Web catalog, command form, Workspace page/reselection, and candidate mapping
  tests — PASS, 47/47.
- `pnpm --filter @arbor/web typecheck` — PASS.
- `pnpm --filter @arbor/web build` — PASS (Vite reports the existing >500 kB
  chunk-size advisory).
- Targeted Biome and `git diff --check` — PASS.

## Remaining

V6-E real SQLite dual-daemon restart qualification and V6-F broader V5/V6
gates/scope review remain. No P1 contract, schema, migration, provider
qualification, or release claim is added by this slice.
