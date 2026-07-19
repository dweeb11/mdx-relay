---
name: implement-from-plan
description: Execute an implementation plan task-by-task. Follow the spec exactly, commit after each task, verify before marking done.
---

# implement-from-plan

## Before Starting

1. **Read the spec** — find the plan in `docs/`
2. **Confirm the branch** — must match the plan's expected branch.
   Create it if needed.
3. **Identify constraints** — note any "do not modify" files

## Execution Rules

### Task order
- Execute tasks in order. Do not skip or reorder.
- Complete each task fully before starting the next.

### Code and paths
- Use the exact file paths from the plan
- When the plan provides exact code, use it — do not substitute
  with "improved" versions
- Respect "do not modify" constraints

### Commits
- Commit after each task — do not batch
- Use the commit message from the plan when provided
- Stage only files changed in that task

### Verification
- Run the `verify` skill after each task that has testable output
- For tasks with only manual verification: run build check, note
  "manual verification per Acceptance Criteria"

## After All Tasks Complete

1. Run the `worklog` skill to generate the worklog (optional — skip if you don't use worklogs)
2. List any remaining items (user verification, merge, etc.)
