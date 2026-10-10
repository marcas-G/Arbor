# F23 receipt tuple / decode ordering governance landing

Date: 2026-10-10
Isolated worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`
Landing base: `860d89d49946e70541b1b13f2650e25d3edc15c7`

## Decision and accepted proposal

The manual governor accepted the fixed proposal, as relayed for this landing
on 2026-10-10. Decision token: `DECIDE_F23_RECEIPT_TUPLE_DECODE_ORDER`.
The exact proposal file
`C:\Arbor\planning\proposals\F23-receipt-tuple-vs-decode-ordering-governance-draft.md`
was hashed before landing; its SHA-256 is
`51518D3B2F7BEFD453E8026189753F724EBADC88B2B4A33D067B5F41C7969F2D`, matching
the accepted value. The proposal file was not changed.

## Accepted owner landing

Only the proposal's two owning P1 documents and this landing record changed:

| Owner | Focused amendment | SHA-256 after landing |
|---|---|---|
| `docs/design/implementation/P1/01-command-contracts.md` | §1 receipt typing and §3 tuple-first priority; §8 summary clarified to any tuple-field mismatch | `3025654FC63107C4D4530AAEFF602BC82964C3EC6A2B409A54914161351AD0FE` |
| `docs/design/implementation/P1/02-port-contracts.md` | `CommandStore.findResolution` now returns ports-owned `StoredCommandResolution` with tuple metadata and unparsed raw result/error JSON | `BDCDEFE97F67EEF668FFFEB5F0C1CB2CE4356A838824FC02CDF853FCF97F8450` |

P1 `01` now makes the existing branch order explicit: compare the stored
`(semanticRequestFingerprint, schemaVersion, fingerprintAlgorithmVersion)`
before interpreting result/error JSON. A tuple mismatch remains the existing
`IdempotencyConflict` branch; it does not decode or disclose the raw result or
error fields and leaves the stored row unchanged. Only an exact tuple match
may proceed to the existing Application receipt decoder.

P1 `02` defines the pre-decode row representation needed by that sequence,
including the stored resolution and tuple metadata, raw `resultJson` /
`terminalErrorJson` text, and existing receipt timestamps/identifiers. The
Store reads within the existing command transaction and does not parse,
validate, or otherwise interpret those JSON fields.

No numbered document-version scheme was added: these P1 files have no focused
revision field, so their Git revision and post-landing digests identify the
owner revisions. No other owner document changed. In particular, there is no
DID version bump, SQL/schema/migration change, gateway implementation, test
change, receipt repair path, or implementation authorization.

## Consistency self-review and scope boundary

- P1 `01` continues to require External authentication, strict wire decode,
  exact Actor/Principal binding, and Resolver visibility before Gateway; no
  receipt pre-read was introduced.
- `BEGIN IMMEDIATE` remains the sole receipt lookup/linearization point, and
  the existing tuple comparison still precedes the final exact authority check
  as frozen in DID v1.34 §4.1B and P1 `03`.
- P1 `04`'s tuple and row constraints are unchanged. The typed P1
  `CommandReceipt` remains the post-comparison decoded value; the raw Store
  representation does not become a domain receipt or persisted new entity.
- The landing does not define exact-tuple result/error shape validation, a
  runtime decoder, typed corruption/error codes, Problem/Attention mapping, or
  repair semantics. FT-DG-03's already accepted high-level exact-tuple
  fail-closed requirement remains in force; these implementation details
  remain unresolved and require separate governance before implementation.
- The existing P1/DID tuple-first priority was clarified, not changed. No
  broader receipt-integrity implementation is authorized by this landing.

No tests or production commands were run. `git diff --check` passed before
commit. The accepted package is limited to the two P1 owner amendments above
and this record.
