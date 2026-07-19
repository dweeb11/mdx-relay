# Working Agreement

This document defines how AI-assisted development works in this project.
It is tool-agnostic — it applies to any AI assistant used in this codebase.

---

## Core Principles

**Evidence over assertion.** Never claim work is done without running
verification and showing the output. "Should work" and "looks correct"
are not evidence. Exit codes and test counts are.

**Design before code.** Never start implementing without an approved design.
Even small features benefit from a one-paragraph design that gets explicit
approval before any code is written.

**Test as you go.** Write tests for logic before or alongside implementation.
Verification is part of the task, not a step after.

**Minimal scope.** Only build what was asked for. No extra features, no
speculative abstractions, no "while I'm here" refactors. YAGNI ruthlessly.

---

## Feature Development Process

Every non-trivial feature follows this sequence. Do not skip steps.

1. **Brainstorm** — explore idea, ask one question at a time, propose 2-3 approaches
2. **Design approval** — present design sections, get explicit approval on each
3. **Write spec** — save to docs/ (design + plan in one doc)
4. **Execute** — implement task-by-task, verify before marking each done
5. **Verify** — user confirms acceptance criteria
6. **Docs (optional)** — deliverable report for complex/risky features only

**One question at a time** during brainstorming. Don't ask three questions
in one message.

**Get approval at each design section** before presenting the next one.

**Commit frequently** — after every task, not at the end of a session.

---

## Spec Conventions

**Requirement priority markers:**
- `MUST:` — Implementation cannot deviate
- `SHOULD:` — Preferred approach, can deviate if justified

**Plan format — every task includes:**

### Task N: [Name]

**Files:**
- Create: `exact/path/to/file`
- Modify: `exact/path/to/file`

**Implementation:**
[exact code — not descriptions of code]

**Verification:**
Run: [exact command]
Expected: [exact expected output]

**Acceptance Criteria:**
- [ ] What a human verifies

**Automated Tests:**
- `test_file` — what logic is covered
- None (reason)

"None" must always include a reason — it's a conscious decision, not
an oversight.

Exact file paths always. No "update the handler" — name the file.

Complete code in the plan. Not descriptions of code — the actual code.

---

## Testing Philosophy

**Two-track testing:**

| Track | What | How |
|-------|------|-----|
| Automated | Pure logic, state, data processing | Unit/integration tests |
| Manual | UI behavior, visual output, interactions | Acceptance Criteria checklist |

**Automated tests cover:**
- Business logic / game logic
- Data persistence
- State transitions
- Edge cases and boundary conditions

**Automated tests do not need to cover:**
- Every getter/setter
- Framework/engine behavior
- UI layout and rendering

---

## Verification Before Completion

Before marking any task complete, run all verification steps and show output.

**Required evidence:**

    Tests: X passed, 0 failed
       [paste actual test output]

    Build check: exit 0
       [paste command output]

    Acceptance Criteria:
       - [x] Item 1 — implemented in filename:line
       - [x] Item 2 — implemented in filename:line

**Red flags — stop and re-verify if you catch yourself saying:**
- "Should work now"
- "I'm confident this is correct"
- "Looks good to me"

No exceptions for "simple" tasks.

---

## File Ownership

**Human-owned files — agents never modify:**
- `PITCH.md` — the design vision
- `SCRATCH.md` — runtime notes and thoughts

**Agent-updated files — only when asked or at natural checkpoints:**
- Spec docs, design docs
- Worklogs (optional — not all projects use them)
- The human may ask the agent to incorporate SCRATCH.md notes

---

## Communication Style

- Short responses — don't pad with summaries of what was just done
- No unsolicited refactors — fix what was asked, nothing else
- No emojis unless explicitly requested
- Flag risks before acting — if an action is hard to reverse, describe it and ask first
- Ask one clarifying question at a time — not a list of five
- Reference code by file and line — `filename.py:42`, not "in the handler"

---

## What Not to Do

- Don't start coding before design is approved
- Don't claim completion without evidence
- Don't add features beyond what was asked
- Don't skip tests because something "seems simple"
- Don't use force push, hard reset, or destructive git operations without confirmation
- Don't add comments or docstrings to code you didn't change
- Don't add error handling for scenarios that can't happen
- Don't create abstractions for one-time use
