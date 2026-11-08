# Governance P36–P40 Final Design Review Result

Date: 2026-10-11  
Reviewed baseline: `8c0ca298c258c0ca12fed4745486c458fb3f13ea`  
Status: **Independent final design review PASS; Blocking = 0. Migration,
runtime, Windows, and release qualification remain open.**

## Review disposition

The independent final review returned **Blocking = 0** for the integrated
P36–P40 owner-contract design. The review confirmed the accepted P39/P40
compatibility boundary and verified all 22 owner-file LF SHA-256 values in
`planning/results/AH7-DG-01-P40-design-landing.result.md` against the integrated
tree. A local recomputation using UTF-8 after CR/CRLF-to-LF normalization
matched **22/22** entries.

The P7 Deliver migration-reference correction and its separate governance
decision were included in the reviewed baseline. The earlier Blocking = 1
governance-scope finding is closed by
`planning/results/AH10-deliver-p7-migration-reference-correction-governance-decision.md`.

## Fixed accepted inputs

| Package | Accepted LF SHA-256 |
|---|---|
| AH7-DG-02 logical decision (P39) | `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` |
| AH7-DG-02 physical supplement (P39) | `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C` |
| AH7-DG-01 logical decision (P40) | `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD` |
| AH7-DG-01 physical supplement (P40) | `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A` |
| P39/P40 ReconciledNoEffect compatibility addendum | `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830` |
| P39/P40 compatibility SQL/source/replay/legacy/kill matrix | `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35` |

All six source proposal hashes were recomputed from their LF-normalized UTF-8
contents and matched. The accepted package and owner landing records remain in
the planning/results artifacts listed above and in the corresponding AH7
acceptance records.

## Integrated design versions and migration boundary

- System Design: v1.16.
- Detailed Implementation Design: v1.41.
- The original green `C:\Arbor@f80ee91` baseline remains at P35. The unified
  design tree also has migration baseline 35: `migrations.ts` registers id 35
  (`workspace_resource_activation_intents`), and readiness uses
  `P35_MIGRATION_BASELINE`.
- P36–P40 owner contracts are integrated as design. No migrations 0036–0040
  are registered or implemented in this tree; no migration was run.
- P39 sidecar/preflight/maintenance and legacy-cohort behavior remains a
  design contract only. P39 Windows/local-filesystem durability, sidecar
  retention, and deployment qualification are open.
- P40 cumulative-runner serialization and P36–P40 installed-database upgrade
  qualification are open. No Windows, runtime, crash, migration, or release
  readiness is claimed by this review.

The accepted review closes the design-consistency gate only. Any implementation,
migration registration, or release requires its separately authorized phases
and the specified platform and recovery qualification.
