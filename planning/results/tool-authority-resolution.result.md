# Tool Authority Resolution — Result

## Status

**COMPLETE / VERIFIED — 2026-10-01.**

## Delivered

- Added the `ToolAuthorityResolver` Port at the post-region-resolution Tool
  Runtime boundary.
- Production resolution loads canonical Workspace policy and active
  PermissionGrants, then delegates exact fact construction to
  `AuthorityResolverPort.resolveInvocation`.
- `fs:read` is the ResourceBoundary-limited list/read baseline.
- Shell/write capabilities fail closed without an applicable active grant.
- Removed production hardcoded capabilities, fixed 2999 expiry and fixed
  control-basis digest from `ExecutableToolHandler`.
- Authority now binds the exact manifest ControlBasis digest and policy TTL.

## Evidence

- read baseline / shell denial test: PASS
- authority/tool pipeline/driver/composition focused suite: PASS (28/28)
- lint: PASS (792 files)
- typecheck: PASS
- architecture: PASS (121/121)
- core tests: PASS after governance-index correction (1491 passed, 1 skipped)
- web typecheck/build: PASS
- web tests: PASS (211/211)
- git diff check: PASS
