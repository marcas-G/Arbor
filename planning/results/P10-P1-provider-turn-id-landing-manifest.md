# ProviderTurnId V2 Closed Codec — Owner Landing Manifest

Acceptance token: `ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`.

Accepted proposal:
`planning/proposals/P10-P1-provider-turn-id-codec-gap-draft.md`, canonical LF
UTF-8 SHA-256
`5794DD19BA3BF1BDF58C0878863F1F51EA154CBF541E893CFA1CC63758108D2E`.

Decision record:
`planning/results/P10-P1-provider-turn-id-governance-decision.md`.

Landing baseline: `4df658d1c0682e1329891dc01ad8734b65d465bd`. The hashes below
are canonical LF UTF-8 SHA-256, with CRLF normalized to LF and no BOM. They
were verified against the accepted landing diff before commit.

| Owner | File | Baseline SHA-256 | Landed SHA-256 |
|---|---|---|---|
| Top-level DID — identity grammar, manifest, provider and P20 references | `docs/design/03-detailed-implementation-design.md` | `52A25911706A89BE54B9FB110CEE6AEBBC8B088EB60605A1B970EE8E7CE772AF` | `33512E30E05D76E59B0EEBE999DEDF9A74E392D0286385F346E0A8A1D169AC32` |
| P1 index | `docs/design/implementation/P1/00-contract-index.md` | `B736EFBC3DBCD97E7D0BAC98C9D46D25646FC2C14A456EDD19E5D5A7A17C9DC7` | `3A5A7F5EB1F2B905F5E88ADA8553644E4C1ED9E37151F9DDAC4EEF2F8E263FEB` |
| P1 result/receipt decode compatibility | `docs/design/implementation/P1/01-command-contracts.md` | `F2C888E2F96D358A25F0BFAFE5FF4BE5C70CF5AF4EF747575A19EF0BFF132822` | `81C907E84C3344BE2D37535BED2768A63EB2D92EDD8C72AC8DFD60E6F19D6BF4` |
| P2 index | `docs/design/implementation/P2/00-contract-index.md` | `2FF949A59A4FBBC7E6AA8A385AFCE5E5A4E6FD8290CDC7182179A6C235D6FA9D` | `1D105552CF6C937566611F6692EFB3217BDADBA3C424B1BEAA7C9F5C80B29D8A` |
| P2 Blocked action-reference contract | `docs/design/implementation/P2/01-command-contracts.md` | `ED60712C50307C2D615BCF42E30A1074E6B81AF7BCB85FFAF8EE0BC006B9DE73` | `D7A4965CE2FDC6B34F1FF9B23213813DEE84C2BEEE074B65B1FC190B93683412` |
| P2 AgentLoopStep TEXT storage | `docs/design/implementation/P2/04-sqlite-schema.md` | `49786BED97868B545527B2BA5D3D08C0BA81F948730AEEE709A2B7ABAF495BA2` | `BF2F779C93F8C759E954ABBF27BA127915D2505234F1EAAEB8B1E3F0EA0986B6` |
| P3 index | `docs/design/implementation/P3/00-contract-index.md` | `B7F2E8FD62CF37D483246F9F5EA3DC6B9B0E940ECE258BE619BA88FAC6B14FB0` | `E209D3333D77CB3B750578696E25ED29DC0669E0A79BFE4F8D05BBB214A76E41` |
| P3 ProviderContext/events and exact ID propagation | `docs/design/implementation/P3/01-provider-contracts.md` | `1F4E4E0839AC28C6AE690F03A86169C22B6FEA7EA6825A68799F67877E23E297` | `88D7FD4954C261B4B18DA6AE8E1DA9B1D13EFA7CA0C68295717331CA9183D595` |
| P3 Manifest and compaction replay | `docs/design/implementation/P3/02-model-context-contracts.md` | `3D2D5C235D6FA092464559354A25956E2AC2DCE4D28299CE6A99DB1AD7CC61CF` | `1FFDFAA07F2804F328411913BA48D3163DDBE35EFFBDBFD4E83A66C2F816EE69` |
| P3 ProviderTurn/Manifest TEXT storage | `docs/design/implementation/P3/04-sqlite-schema.md` | `1F48A73CDFA8E90117504FA55B8983A92AB509466972309D89D68B62CEFB1140` | `0D73D42DCEFB1D288CE6450794ED3251CB8D0F6F2916B6FE5A6E12F806FF3B90` |
| P3 Step, repair, and P20 chain identity | `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `80E9D7607B927615E3CBE6C4B8476B82423D7E46FB2CA768096D11965D292D4E` | `19BA44A0A513E0C8F14512C6D96F1FE4C15D011B95E3C0D73C6B113347CD1993` |
| P4 requirement source decode | `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `37250653E0A4C50A3D5BE2B757BEBCEE90259247C0E29E33151D86180E143404` | `E5E139CB54F7442CAB8FB52D098720BC1CDF4247EC9CB804ACB98075B343D009` |
| P9 index | `docs/design/implementation/P9/00-contract-index.md` | `934DEEBA8CE872BE657D15747DEB642498BA0D223AC56A088F478CC16B1DAE87` | `7DD3CE2B2823603FF7DF818B6B2CB7AF07C8F7F8EAD324DCA940C4B140C70C9C` |
| P9 recovery, exact replay and legacy adoption | `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `F9F7CD1E7388A9209644A4CC4625DBD460E142FFF42DCFCF54F3500B3D0B6D5E` | `D45064DA358B9978B40348DF1B63461FBE70F16DCF25FC6733C1CA3324012F8F` |

The landing changes only these listed owner documents and this planning
decision/manifest. Top-level Problem & Goals, Scenarios, System Design,
implementation code, tests, migrations, SQLite files, receipts, and Provider
rows are not modified. There is no DDL/backfill or release/provider
qualification claim.
