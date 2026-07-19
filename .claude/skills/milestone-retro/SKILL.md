---
name: milestone-retro
description: Run at the end of every milestone. Gathers data from git history, specs, and worklogs (if used), then produces a structured retrospective covering what went well, what could improve, and lessons for future milestones. Saves output to docs/retros/.
---

# Milestone Retrospective

Run this at the end of every milestone to reflect on process, quality, and velocity.

## Step 1: Identify the milestone

Determine which milestone just completed from the project's task tracking (e.g. `docs/plans/tasks.md`, issue tracker, or recent conversation context).

## Step 2: Gather data

Collect the following from the repo:

1. **Git history** — all commits on main since the previous milestone merge. Use:
   ```bash
   git log --oneline <previous-milestone-merge>..HEAD
   ```
   Count: total commits, features, fixes, docs, tests.

2. **Specs written** — list all spec or design files created for this milestone.

3. **Worklogs** — read any worklog entries for this milestone's features, if they exist (e.g. `docs/worklogs/`). Worklogs are optional — skip if not used.

4. **Bugs found during verification** — scan commit messages for `fix:` commits that happened mid-feature (not pre-planned fixes). These represent things the spec or plan missed.

5. **Branch history** — how many feature branches were created? Any that required rebasing or conflict resolution?

## Step 3: Produce the retrospective

Structure the output as three sections:

### What went well
- Process wins (things that saved time or caught bugs early)
- Technical wins (clean implementations, good abstractions)
- Workflow wins (tool usage, parallelism, communication)

### What could improve
- Spec gaps (things discovered during implementation that the spec didn't cover)
- Process friction (steps that slowed things down without adding value)
- Technical debt introduced (shortcuts taken, known issues deferred)

### Lessons to carry forward
- Concrete, actionable items for the next milestone
- Pattern changes to adopt or stop
- Updates to CLAUDE.md, working agreements, or skills if warranted

## Step 4: Save the retrospective

Write to `docs/retros/milestone-N-retro.md` (or `YYYY-MM-DD-<name>-retro.md` for non-numbered milestones) with this header:

```markdown
# Milestone N Retrospective

**Date:** YYYY-MM-DD
**Features completed:** (list)
**Total commits:** N
```

## Step 5: Ask the user

After presenting the retrospective, ask:
- Are there any lessons I missed?
- Should any of these lessons become permanent process changes (CLAUDE.md, skills, working agreement)?
