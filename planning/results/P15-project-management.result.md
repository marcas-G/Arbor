# P15 Project Management — Result

## Status

**IMPLEMENTATION COMPLETE / VALIDATED — 2026-09-30.**

## Delivered

- Project and Workspace navigation remain distinct.
- RenameProject and CloseProject are authorized, revision-CAS, receipt-idempotent canonical commands.
- ProjectRenamed and ProjectClosed are durable events.
- Local principal-scoped project directory is exposed independently from project-scoped ViewId.
- Web switches projects by name; raw ProjectId is not the normal interaction.
- Settings exposes rename and archive; archived projects are hidden by default and can be revealed.
- P18 adds HumanMessage Declined terminal state.
- Closed projects reject new human messages.
- Pending/unadmitted/failed conversation turns converge without Closed-project retry loops.
- Close requests cooperative stop for every unsettled execution in the project.

## Mechanical evidence

- pnpm lint: PASS (751 files)
- pnpm typecheck: PASS
- architecture: PASS (115/115)
- core tests: PASS (1465 passed, 1 skipped)
- web production build: PASS
- web tests: PASS (211/211)
- P18 migration fixture: PASS
- P15 command integration fixture: PASS

## Real local validation

Database: C:\Arbor\arbor-local-17.db, migrated in place by the restarted 8787 daemon.

Observed through real HTTP:

- existing Open project remained readable;
- created P15 validation project: Committed;
- renamed it: Committed, revision 1;
- archived it: Committed, lifecycle Closed, revision 2;
- Closed project rejected SubmitHumanMessage with TerminalLifecycleMutation;
- restart preserved project name, lifecycle and revision.

Validation artifact left intentionally as test data:

- P15 验证项目·已改名 (Closed)

## Residual scope

Multi-principal ProjectDirectory visibility resolver remains fail-closed and is not implemented by this local single-user phase. Narrow-screen project switching was explicitly deferred by the user.

