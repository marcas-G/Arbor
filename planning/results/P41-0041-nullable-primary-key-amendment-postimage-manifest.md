# P41 / 0041 fact-key nullability amendment — owner postimage manifest

Date: 2026-10-12
Base: combined design owner landing `251b47de9b58a22d404345945d3b416ec2884c4f`.
Amendment proposal LF SHA-256:
`BE7E9CC9F3528ADBA90EF67615FE1C24E92B5FE751782151882ACAA4531E2BC9`.
Acceptance: `planning/results/P41-0041-nullable-primary-key-amendment-acceptance-and-landing.md`.

## Owner postimages

SHA-256 values are over UTF-8 after CRLF→LF normalization, with no BOM.

| Owner file | Before LF SHA-256 | After LF SHA-256 | Disposition |
|---|---|---|---|
| `docs/design/03-detailed-implementation-design.md` | `1990E2DCE2EAB46E700AF6FCE566496E525D29AE8B88747F3CEF61F6194897F2` | `CCA4CB967A0FD45D4756E7DB2175E494956E06B4E0A55BCEE1619EE5552B3C17` | DID v1.44→v1.45 amendment history only |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `927FF7273C9C90133E796E1FF9A772B782B9FAB775D3E62DA3DD73504DD62900` | `71E21AA94A0B3D696809C01070543F8E2DC2ED5E1AEA42D8764268B87C51FFF8` | Exact accepted P1 hunk |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `C6001299CE5C5807B45452F10CE8B0C8D60C223A060FFC0C628FB2A23FF21231` | `BF8CB25FE0DCC0F9BC8994F3C2E05F7FA06A3C007C361457CA3FB35910C34DF8` | Exact accepted one-line DDL change |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `CE66354DF5B554DCDFA86FAD114C6BAD258DC823649271884567AD8D14DE2A5B` | `CE66354DF5B554DCDFA86FAD114C6BAD258DC823649271884567AD8D14DE2A5B` | Unchanged |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `1636DB544ED6E3E0BF7C8AB062A8319B01E731B0031B03C1E799FC49B7DC128B` | `1636DB544ED6E3E0BF7C8AB062A8319B01E731B0031B03C1E799FC49B7DC128B` | Unchanged |

The historical combined v1.44 45-file manifest remains unchanged. This narrow
manifest records only the amendment's postimages and explicitly shows that
P10 owner files were untouched.

## SQL and descriptor digests

- Corrected P9 DDL body SHA-256 (LF UTF-8, no template delimiters):
  `8B5908A58CBC9F75B8188DF4FA6D22481F60B028581A603B022F1D883373846A`.
- Descriptor fingerprint SHA-256 over LF-separated `41`,
  `p41_submitted_decision_binding_attention`, and lowercase DDL body digest,
  with no trailing newline:
  `1C4B30B9FC08569C8B50A9333EA115562A2AC93EE81CC869CDA97D5FE75149A1`.
- NULL-insert reproduction statement SHA-256:
  `E996114D1421CEC32E2F83F24CE0B90259CDCF9D9186731D376A460B6F4F711E`.
- Proposal SHA-256:
  `BE7E9CC9F3528ADBA90EF67615FE1C24E92B5FE751782151882ACAA4531E2BC9`.
- Independent proposal review SHA-256:
  `27740A79287CCBACB92D05983EF4661A048DE46440AD7883AAFDF3E4FC76A142`.

The P1/P9 after hashes equal the exact postimages fixed in the accepted
proposal. No executable migration descriptor, code-side manifest, production
source, or database was changed by this design landing.
