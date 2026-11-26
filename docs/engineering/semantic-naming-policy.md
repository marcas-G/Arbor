# Semantic naming policy — ratchet adoption plan

Status: adopted as architecture-evolution object 11 (owner decision
2026-11-26, Rust-tidy precedent). Owner document for the phase-number
naming debt (P17/AH19-style identifiers leaking project-management
names into the software namespace).

## The diagnosis

Project-management identifiers (P17, AH19, Story A, milestone names)
propagate into files, symbols, test names and Service keys because the
task name is the path of least resistance when an agent implements a
phase. The namespaces must be separated: management identifiers live in
git history, PRs, design records and comments — never in software
names. Traceability comes from records, not shared vocabulary.

Scale measured 2026-11-26: 385 test files under p*/ah*-named paths,
131 at tests/ root, 13 P/AH-prefixed symbols in production sources,
412 describe/it names carrying phase numbers.

## The ratchet (Rust tidy precedent)

Three moving parts, in `scripts/governance/`:

1. `check-semantic-naming.mjs` — narrow checks, not a blanket
   alphanumerics ban. First-batch rules recognize the known historical
   patterns only:
   - new files/dirs matching `(^|[/-])(p|ah)[0-9]{1,3}([/-]|$)` outside
     `naming-baseline.json`;
   - new exported symbols matching `(class|interface|type|const|function)
     (P[0-9]{2}|AH[0-9]{1,2})[A-Z]`;
   - new describe/it names opening with a phase number.
2. `naming-baseline.json` — the existing-violations ledger. Existing
   violations are recorded once; ordinary development may never grow it.
   Every rename removes its baseline entry. It is a debt list, distinct
   from compatibility exceptions.
3. Compatibility exceptions — persisted schema identities, protocol
   names, wire identifiers (schema-v57 is legal software semantics).
   Recorded separately and never cleaned by this campaign.

Wire into CI as a governance step next to check-source-lines, with the
same transition-mode semantics (baseline vs blocking).

## Named-as-used checklist (DeepSeek rename-ledger spirit)

A rename is complete only when the ledger entry is closed across: file
path, exports, import sites, type/function names, Service keys, config
keys, test names, manifest/case-catalog entries, and current-state docs.
The ledger prevents half-renames that leave old vocabulary alive.

**Owner authorization (2026-11-26):** the frozen-design vocabulary is
unfrozen for renaming. P/AH identifiers — including the ones defined in
docs/design/** — may be renamed in code to their semantic names; the
numbered form survives only as traceability (comments, design docs,
migration registers). Per AGENTS.md the design-governance documents
record the semantic mapping as the landing package of an owner-approved
decision; design docs keep the numbered names as historical evidence
while current-state documents lead with the semantic names. Persisted
schema identities (user_version alignment, migration registration
order) are implementation invariants, never renamed — only their
file/symbol labels change.

## Sequencing (respects the current campaign)

| Order | Work |
|---|---|
| 1 | Gate + baseline land immediately (stop new pollution) |
| 2 | Test mass reduction (already running — do not rename doomed tests) |
| 3 | Domain vocabulary table (one concept, one term) |
| 4 | Reorganize surviving tests by capability |
| 5 | Production sources, types, functions |
| 6 | Effect Services, Layers, config, scripts |
| 7 | Persisted-protocol audit (exceptions finalized) |
| 8 | Baseline reaches zero; gate flips to strict |

Rules from Google/LLVM govern judgment for new names: descriptive to a
new reader, names the role that exists today, no meaningless number
distinctions — but real protocol/algorithm numbers (sha256, schema-v57)
stay legal.

## The rules (normative)

| Rule | Constraint |
|---|---|
| Semantic independence | understanding a name must not require project history |
| Phase-number isolation | phase, task and fix numbers are forbidden in software names |
| Role accuracy | a name must correspond to the role that exists today |
| Vocabulary consistency | one concept, one term, at every layer |
| Behavior-named tests | a test name states the behavior it protects |
| Traceability separation | issue/PR/ADR numbers travel through records and comments, never shared names |
| Version exception | numbers with real version, protocol or algorithm semantics are legal |
| Compatibility protection | persisted identities and external protocols are never renamed |

## Worked examples

| Forbidden | Allowed |
|---|---|
| `P17AgentLoopStepStore` | `AgentLoopStepStore` |
| `AH19Recovery` | `ProviderBindingRecovery` |
| `P39WriterLock` | `DatabaseWriterLock` |
| `p9-acceptance.test.ts` | `execution-recovery.test.ts` |
| `helper2.ts` | name by the actual responsibility |
| `new-runtime.ts` | name by the actual capability |
| `phase3-handler.ts` | name by the actual object handled |
| — | `sha256` |
| — | `http2` |
| — | `schema-v57` |

The distinction is not numbers themselves — it is numbers without
software semantics.
