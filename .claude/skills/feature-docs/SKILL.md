---
name: feature-docs
description: Generate the deliverable report and validation documents for the current feature branch. Reads the spec, git history, and project context to produce both docs as a matched pair.
---

# feature-docs

Generate the **deliverable report** and **validation** documents for the current feature. These are created as a pair at the end of implementation, before user verification.

**When to use:** Only for complex or risky features — multi-system changes, new core logic, regression-prone work. Simple features don't need formal deliverable docs; the spec's acceptance criteria plus a passing verification is enough.

## Step 1: Identify the current feature

Run:
```bash
git branch --show-current
```

Extract the feature number and name from the branch (e.g. `feat/1.2-auth-flow` -> Feature 1.2, Auth Flow).

## Step 2: Find the spec

Look in the project's spec or design docs directory for the spec matching this feature (e.g. `docs/milestones/`, `docs/specs/`, or `docs/plans/`). Read fully — the spec contains success criteria, files changed, and expected behavior that populate the deliverable report.

## Step 3: Scan git history

Run:
```bash
git log main..HEAD --oneline
```

This provides the commit list for the "Implemented" section and helps identify what changed.

Run:
```bash
git diff main..HEAD --name-status
```

This provides the files created/modified for cross-referencing.

## Step 4: Generate the deliverable report

Create the file at an appropriate location for the project (e.g. alongside the spec, or in `docs/deliverables/`).

Use today's date. Populate:
- **Implemented**: bullet list of what changed, referencing specific files and components (from spec + git diff)
- **Expected outcome**: 2-3 bullets describing what the user should see or experience
- **Test steps**: numbered manual test steps covering all success criteria from the spec
- **Test results**: automated test results if applicable; `Manual: Pending user verification`
- **Known issues**: from the spec's pitfalls/edge cases section, or "None identified"
- **Next suggested step**: user verification -> merge PR -> next feature

## Step 5: Generate the validation document

Create the file alongside the deliverable report.

Use today's date. Populate:
- **What Changed**: brief description from the user's perspective
- **What to Expect**: bullet list of observable behaviors when verifying
- **Validation Checklist**: checkboxes covering core behavior, no regressions, configuration, edge cases, and feedback
- **Pass Criteria**: all checked, no blockers, known issues documented
- **Validation Results**: empty table for the user to fill in

## Step 6: Output summary

Show both file paths and a brief summary of what was generated. Remind the user to verify and fill in the Validation Results table.
