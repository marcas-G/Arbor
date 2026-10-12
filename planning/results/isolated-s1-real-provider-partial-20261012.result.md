# Isolated S1 Real-Provider Journey — Partial Result

Date: 2026-10-12 (Asia/Shanghai)

Status: **NOT PASS — partial real-provider journey; Verification did not
conclude and no Acceptance or Work completion was recorded. This is not S1
closure.**

## Scope and isolation

- Release worktree: `C:\Users\ThinkPad\.codex\worktrees\first-release-delivery\Arbor`.
- Candidate source at capture: `8d3576155992389980673c70615f61496ff4e1a2`.
- Isolated daemon URL: `http://127.0.0.1:8791` (daemon PID 15592 during the run).
- Isolated database: `%APPDATA%\ArborFirstRelease\isolated-acceptance-e8d90756-20261012\data\arbor-slice.db`.
- Isolated Project files root: `%APPDATA%\ArborFirstRelease\isolated-acceptance-e8d90756-20261012\workspace`.
- Provider config was referenced externally at `C:\Arbor\arbor.config.json`; modelRef `model-deepseek-v4-flash`, wire model `deepseek-flash`. The secret value was not read, copied, or recorded. No mock provider response was used.
- User daemon on port 8787 was outside this run and was not modified.

## Public journey and observed effects

1. `GET /project-resources` returned HTTP 200. Through the actual Web UI,
   CreateProject committed Project `prj_01a12eea-1eff-73ca-afe1-d9f97fd142d0`
   (`S1 隔离真实验收 20261012`) and root Workspace
   `ws_01a12eea-1eff-74e1-8112-756f5eb0636c`. CreateProject CommandId:
   `cmd_01a12eea-1eff-781b-9e1d-4587204f6d07`.
2. A real DeepSeek RootConversation proposed one exact AssignWork goal:
   create only `proof.txt` in the Project files root, with the single line
   `FIRST-RELEASE-ISOLATED-PROOF-20261012`, read it back, and continue the
   independent Verification mission. The exact approval was accepted once.
   Work `wrk_27ad1efe-50c8-7b1e-88b4-cf5a4eb93014` was created Open/revision 0;
   AssignWork CommandId `cmd_28ff216a-9e11-77f2-8c4b-2e5561615dfd` committed.
3. Initial executable-tool attempts were rejected by the runtime. Under explicit
   authorization for this isolated test Project, one bounded permission was
   then committed: GrantPermission CommandId
   `cmd_01a12f0c-ac0d-7dc1-b6ca-30b5e65c0eb9`, grant
   `pgr_01a12f0c-ac0b-7f33-838f-30b72d326008`, subject and target exactly the
   root Workspace above, capability `fs:write`, issuer `user:local`, expiry
   `2026-10-12T08:45:00.000Z`. No `shell:exec` permission was granted.
4. One authorized SteerWork was committed: CommandId
   `cmd_01a12f0e-721e-7781-8317-f231f2d71fcb`; event
   `5b2474e2-add3-4105-9a6b-bb900717d317` advanced Work revision 0→1. It asked
   the existing Work to use patch to create only the specified file, read it
   back, and not use shell/network/other files. This was not resent.
5. The real WorkEpisode `exe_b7f03915-f1cb-7a95-8212-a2e67383b94e` completed.
   Publicly rendered Work detail showed the Work still Open/revision 1. The
   isolated filesystem was also inspected read-only: the only regular file was
   `proof.txt`, 37 bytes, with exact content
   `FIRST-RELEASE-ISOLATED-PROOF-20261012`. The Work actions included patch
   Applied and read Applied. This confirms the bounded file effect, not an
   accepted deliverable or a completed Work.
6. Independent Verification
   `ver_174f32cd-5475-7fbf-81b0-434ac4753138` remained Open; V1–V4 were all
   `Unknown`. The verifier execution
   `exe_0e032f93-4ca5-7552-8d9e-a07566f4e544` settled Interrupted at
   `07:42:06.915Z` without ConcludeVerification. Public evidence references
   were `evd_5cbc457d-695c-7903-8c3b-2249f5c216de` and
   `evd_f41812d2-2e78-71bf-8f05-54cb3e1d9889`.
7. Public Attention contained one `VerifierOrphan` for the root Workspace,
   summary: `open verification ver_174f32cd-5475-7fbf-81b0-434ac4753138 has no
   active verifier execution (settle-without-conclude)`. Its UI offered only
   “open target workspace” and stated that opening does not change the item;
   no Retry/Resume/repair action was visible. Public Queue was empty.
8. No Acceptance, `CompleteWork`, Work close, or restart qualification was
   performed. Work remains Open/revision 1; Verification remains Unknown. Do
   not interpret an empty Queue as execution completion. **The S1 journey did
   not pass.**

The real verifier attempted read-only shell-style inspections despite no
`shell:exec` grant and despite the steering constraint. This is recorded as an
observed behavior for diagnosis, not permission to broaden the grant or rerun
the verifier. The public API exposed the evidence reference IDs but not their
underlying evidence content.

## Screenshots and database evidence

Screenshots 20–38 are retained outside the repository under:

`%APPDATA%\ArborFirstRelease\isolated-acceptance-e8d90756-20261012\evidence\`

The numbered captures cover Project creation (20–21), real-provider Work
approval and execution/early tool failures (22–30), bounded permission setup
and committed grant (31–33), SteerWork and resulting Work detail (34–35),
VerifierOrphan Attention, Unknown Verification, and empty Queue (36–38). The
directory contains the individually numbered PNG files; none contains a
provider secret.

An online SQLite backup was made earlier for diagnostics at
`%APPDATA%\ArborFirstRelease\isolated-acceptance-e8d90756-20261012\evidence\diagnostic-live-snapshot-20261012.db`.
At creation it passed `PRAGMA integrity_check` (`ok`), size 5,500,928 bytes,
SHA-256 `8df0fe18fc348adbb1f5413afa4fc3610fae5ffcc984a482cf0bd17ebf027b0c`.
**That backup predates the GrantPermission, SteerWork, file effect, and
VerifierOrphan evidence above; it is not a snapshot of the final journey state.**
The live database and isolated evidence directory were retained after daemon
shutdown for diagnosis.

## Disposition

This result is a partial real-provider/browser observation only. It does not
claim release acceptance or S1 closure. The first blocking public lifecycle
gap observed after the file effect is the orphaned Open Verification with
Unknown criteria and no visible recovery action. The Project and Work were
intentionally preserved, and no Acceptance was recorded.
