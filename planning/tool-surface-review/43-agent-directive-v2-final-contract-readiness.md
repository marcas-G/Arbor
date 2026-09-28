# AgentDirective v2 Final Contract Readiness

**Date:** 2026-09-27
**Status:** Not ready for model-facing representation design

## Gate result

The source audit and scoped G-V2-3 assessment leave four semantic mappings
open. A compatible content-to-BlobRef path was identified, but frozen P8
does not durably link that ref to the conclusion, so the v2 contract readiness
gate still fails.

| Gap | Final source classification | Result |
|---|---|---|
| G-V2-1 `AssignWork.Provenance.predecessorWorkId` | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-1 `AssignWork.Provenance.reason` | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-2 ToolObservation exact source identity | `DESIGN_UNRESOLVED` | OPEN |
| G-V2-3 `ConcludeVerification` summary content / `summaryRef` | `DESIGN_UNRESOLVED` | OPEN; see `44-g-v2-3-conclusion-summary-closure.md` |
| G-V2-4 `initialWork` / `VerificationMission` lifecycle | `DESIGN_UNRESOLVED` | OPEN |

## Readiness matrix

| Requirement | Result | Evidence |
|---|---|---|
| 15 ACTIVE action identities represented | **PASS, unchanged** | `planning/tool-surface-review/38-agent-directive-v2-semantic-proof.md`, coverage section |
| 14 structured branches defined | **PASS, unchanged** | `planning/tool-surface-review/35-agent-directive-v2-contract.md` |
| 14/14 semantic source mappings complete | **FAIL: 10/14** | `38-agent-directive-v2-semantic-proof.md`; four source mappings remain open |
| Deterministic downstream mapping for all branches | **FAIL** | Provenance, observation reference, summary durable link, and initial mission source remain unspecified |
| No invented semantics/defaults/placeholders in the v2 mapping | **NOT PROVEN** | The reviewed sources do not supply the missing values; P6's old placeholder is not a valid closure mechanism under P8's verification rule |
| Unresolved action overlap = 0 | **PASS, unchanged** | Accepted Action Language governance and `38-agent-directive-v2-semantic-proof.md` |
| Ready for model-facing representation design | **NO** | Canonical source semantics remain incomplete |
| S01 representation planning may restart | **NO** | v2 semantic readiness gate has not passed; implementation remains unauthorized |
| Wave 2 | **NOT STARTED** | Out of scope |

## Placeholder and inference audit

This review added no placeholder or inferred semantic value. It did identify
the existing P6 placeholder-mission rule and the P8 rule that such a mission
must be refined before verification. That historical/current-design
combination remains unresolved for new child `initialWork`; it is not adopted
as a v2 default.

The following tempting mappings remain unauthorized because no frozen rule
supports them:

- copy `AssignWork.why` into `Provenance.reason`;
- infer `predecessorWorkId` from whichever Work happens to be current;
- treat `ToolInvocationId`, `resultRef`, or generic Session `ref` as the
  ToolObservation identity without a frozen equivalence;
- assume the compatible model-content → P4 BlobRef candidate is a complete
  durable P8 mapping; the frozen Verification state/event does not retain it;
- synthesize `VerificationMission` from initial Work text or assume a later
  refinement always occurs.

## New Design Gap assessment

No new fifth gap is required. The missing durable association is part of
G-V2-3's existing summary-to-conclusion chain; all four existing gaps remain
open.

## Final status

```ini
structured_branches = 14
action_identity_coverage = 15/15
semantic_mapping_closed = 10/14
field_source_gaps = 4
unresolved_overlap = 0
agent_directive_v2 = DESIGN_DRAFT_WITH_BLOCKING_SEMANTIC_GAPS
ready_for_model_representation_design = NO
S01_representation_planning = NOT_AUTHORIZED
implementation = NOT_AUTHORIZED
Wave_2 = NOT_STARTED
```

No production code, Prompt, frozen Output Contract, Runtime behavior, or
model-facing tool schema was changed. No model was called and no runner or
implementation planning was started.

## Evidence

- `planning/tool-surface-review/40-v2-field-source-closure.md`
- `planning/tool-surface-review/41-verification-reference-semantics.md`
- `planning/tool-surface-review/44-g-v2-3-conclusion-summary-closure.md`
- `planning/tool-surface-review/42-initial-work-verification-mission-decision.md`
- `planning/tool-surface-review/35-agent-directive-v2-contract.md`
- `planning/tool-surface-review/36-agent-directive-v2-branch-matrix.md`
- `planning/tool-surface-review/38-agent-directive-v2-semantic-proof.md`
- `planning/tool-surface-review/39-s01-v2-readiness-review.md`
