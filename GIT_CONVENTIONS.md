# Git Conventions

---

## Branching

Every feature gets its own branch. Do not commit directly to main.

    git checkout main && git pull
    git checkout -b feat/<feature-name>

**Branch naming:**
- `feat/<name>` — new feature or content
- `fix/<name>` — bug fix
- `docs/<name>` — documentation only
- `refactor/<name>` — restructuring without behavior change

**This applies to all tools** — Claude Code, Codex, Antigravity, or
manual development. If you're about to commit on `main`, stop and
create a branch first.

---

## Commits

- Commit after every task, not at the end of a session
- One logical change per commit
- Never commit without running verification first

**Message format:**

    type: short description

    optional body (what and why, not how)

    Co-Authored-By: Agent Name <noreply@provider.com>

**Types:** feat, fix, test, docs, refactor, chore, style

**Subject line rules:**
- 50 characters or less
- Imperative mood ("Add" not "Added")
- No trailing period

**Co-author lines by tool:**
- Claude Code: `Co-Authored-By: Claude <noreply@anthropic.com>`
- Codex: `Co-Authored-By: Codex <noreply@openai.com>`
- Gemini: `Co-Authored-By: Gemini <noreply@google.com>`

---

## Merging to Main

Before merging any feature branch:

1. Run the project's `verify` skill (or equivalent build + test)
2. Confirm all acceptance criteria from the spec are met
3. Merge with `--no-ff` to preserve branch history
4. Delete the feature branch after merge

        git checkout main
        git merge --no-ff feat/<name>
        git branch -d feat/<name>

---

## Reviewing Agent Work

When an agent works autonomously (Codex tasks, background subagents,
any tool producing commits you didn't watch in real-time):

**Treat the result like a PR — review before merging.**

1. Read the diff: `git diff main..feat/<name>`
2. Check that changes match the spec — no extra files, no scope creep
3. Run the `verify` skill
4. If anything looks wrong, ask the agent to explain or fix — don't
   merge and clean up later

This is not ceremony — it's reviewing someone else's work.
