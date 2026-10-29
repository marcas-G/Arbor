# First Release — Real User Acceptance Snapshot

Date: 2026-10-12 (Asia/Shanghai)

Candidate source: `b2a81660a954fa161c7698a5cdab63c81b047eb4`
Release/startup script source: `06b29521b76203aba1744243822751b8ac31601e`.

Status: **PARTIAL — provider smoke passed; product acceptance is blocked by a
CreateProject post-commit convergence failure. The Work execution,
Verification, Acceptance, completed detail, and restart journey are not
qualified.**

The full `pnpm test:functional` suite is incomplete: the broad run was stopped
after the AH19 case timed out at 150 seconds; Playwright did not run. This
browser/Provider smoke does not replace that suite or qualify full release
readiness.

The full `pnpm check` passed on candidate `b2a8166`; the qualification record
is `planning/results/full-delivery-integration-b2a8166-qualification.result.md`.

## Environment

- Production-shaped Web + daemon instance: `http://127.0.0.1:8787`, PID 9720.
- Isolated database: `%APPDATA%\ArborFirstRelease\data\arbor-slice.db`.
- Isolated Project files root: `%APPDATA%\ArborFirstRelease\workspace`.
- Provider: real DeepSeek configuration reference at `C:\Arbor\arbor.config.json`;
  modelRef `model-deepseek-v4-flash`, wire model `deepseek-flash`. The secret
  value was not read, copied, or recorded.
- Browser evidence was captured with Edge/Playwright against the running
  service, not a mock-provider functional fixture.

## Evidence

1. `GET /project-resources` returned HTTP 200 with exactly one available,
   path-free Profile (`project-root`, `Project files`) and ConversationOnly
   support.
2. The Web UI created `Arbor 首版验收 20261012` as Project
   `prj_01a12e7b-6329-7598-92a1-433fed86e35b` at
   `2026-10-12T05:00:00.706Z`. The UI selected the available Profile and
   navigated to `/p/prj_01a12e7b-6329-7598-92a1-433fed86e35b`.
3. A synthetic greeting was sent through the UI to the configured real
   Provider. The assistant replied `REAL-DEEPSEEK-FLASH-HELLO-20261012`.
   This is a real-provider connectivity smoke only; it does not qualify the
   task/tool/verification workflow.
4. A bounded `proof.txt` Work was proposed and its exact AssignWork action was
   approved in the UI. The resulting Work is
   `wrk_5a3e3209-a109-7d60-8c53-9f787f9f559c`, Open at revision 0. The latest
   read-only `current-work`/`workspace-detail` response showed no active
   execution. No `proof.txt` file evidence, Verification, Acceptance, completed
   detail, or restart retention was observed. Clearing the approval queue was
   not counted as execution completion.
5. A second Project, `测试` (`prj_01a12e7b-6e7e-7b55-97e8-849fd149db36`), is
   present at `2026-10-12T05:00:06.528Z`. The user-reported UI error was
   `command/post-commit-convergence-failure`, sourceTag
   `PersistenceConstraintViolation`. Read-only `workspace-detail` shows a
   persisted root Workspace and FileTree boundary at the isolated Project
   files root, but no current Work, pending Works, or audit timeline
   (watermark 3). This is evidence of partial Project persistence, not a
   successful user-visible CreateProject outcome.
6. Public read-only HTTP has no command receipt lookup: `/projects` and
   `/project-resources` are GET routes, `/views/*` is POST-read, and GET
   `/commands` returns HTTP 400. The failed CreateProject CommandId/receipt
   therefore was not available from the public interface.

## Screenshots

Captured under `%APPDATA%\ArborFirstRelease\acceptance\`:

- `01-create-project.png` — initial UI and available Project files choice.
- `02-project-created.png` — created Project.
- `03-provider-hello.png` — actual DeepSeek assistant reply.
- `04-work-approval.png` — exact AssignWork approval summary.
- `05-work-approved.png` — approval queue after approval.

The approval summary visibly included the absolute local Project files path in
the proposed Work objective. This was model-authored approval text; it did not
change the selected resource boundary. The separate user-reported failure
screen was not captured by this run.

## Disposition

This snapshot does not claim first-release acceptance. The release remains
blocked until the CreateProject partial-persistence failure is diagnosed and
fixed on the release candidate, followed by a repeat of the user-facing
Project creation and the short Work → tool evidence → independent Verification
→ Acceptance → completed Work detail after restart journey. The daemon and
isolated database were left running and intact for diagnosis. No existing
`C:\Arbor` database was used. P39–P42 and full S1–S4 qualification were outside
this acceptance run.
