# Programming Paradigm Result Template

Copy this structure into `planning/results/` for every work item.

```markdown
# <Work ID> — Result

Date: YYYY-MM-DD
Owner: <module/team>
Rule(s): <R-IDs>
Scope: <pure / port / application / process / public>

## Change

- What changed:
- What deliberately did not change:
- Design/governance dependency:

## Verification

- Command:
- Result:
- Test scope:
- Relevant failure/retry/restart evidence:

## Acceptance

- [ ] Evidence matches the claimed scope.
- [ ] No unrelated generated artifacts are included.
- [ ] Type/lint/test status is recorded.
- [ ] Remaining limitations are explicit.
```

Never write “complete” without a command result or an explicit governance
decision that is the authoritative acceptance evidence.
