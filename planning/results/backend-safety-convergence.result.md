# Backend Safety Convergence — Result

## Status

**COMPLETE / VERIFIED — 2026-09-30.**

## Closed findings

- Replaced string-prefix sandbox checks with one lexical + realpath SafePathResolver shared by read/list/patch.
- Added adjacent-prefix and symlink/junction escape regression tests.
- Replaced line-number-only patching with strict old/context validation and replay convergence.
- Added CommandGateway ProjectAdmission: Bootstrap, OpenRequired by default, and explicit ClosedAllowed controls.
- Moved Rename/Close out of the P1 handler set into required P15 dependencies.
- Made Pending → Claimed atomically require an Open Project.
- Made Close decline eligible messages and consume their Inbox entries in the same command transaction.
- Added server-side ProjectName v1 normalization and typed rejection.
- Extracted local project listing from HTTP SQL into ProjectDirectory Port + SQLite adapter.
- Replaced phase-migration aliases with CURRENT_MIGRATIONS plus true historical exports.
- Simplified P15 owning contracts to the implemented local single-user product.

## Evidence

- lint: PASS (755 files)
- typecheck: PASS
- architecture: PASS (115/115)
- core tests: PASS (1475 passed, 1 skipped)
- web build: PASS
- web tests: PASS (211/211)

