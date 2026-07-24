# Issue tracker: Linear

Issues and PRDs for this repo live in **Linear** — the canonical issue tracker for this
repo and every project in this workspace. GitHub holds code and PRs only; it is **not**
where work is tracked.

Prefer the Linear MCP tools when they are available in the session (`list_issues`,
`get_issue`, `save_issue`, `save_comment`, `list_issue_statuses`, `list_issue_labels`,
etc.). Fall back to the Linear web app / API described in prose only if MCP is unavailable.

## Where this repo's issues live

- **Team:** `apps`
- **Project:** `mdx-relay`

Create and list issues within the **apps** team and the **mdx-relay** project. Resolve
their IDs at runtime (`list_teams`, `list_projects`) rather than hard-coding UUIDs — the
names above are the source of truth. Scope `list_issues` to this team/project so triage
and ticket work don't pull in unrelated issues.

## The one-issue-one-branch-one-PR rule

- **One Linear issue = one branch = one PR.** Reference the Linear issue ID (e.g.
  `APP-123`) in the branch name, every commit, and the PR description.
- **Exception — multi-issue milestone runs:** when `/ship-it` / `/herdr-ship-it` is
  invoked with multiple issues from one milestone in a single run, ship them as ONE
  milestone branch + ONE PR, committing per slice (issue ID in each commit) and moving
  each issue through Linear as its slice lands. The PR closes all of them
  (`Closes APP-a, APP-b, …`).

## Conventions

- **Create an issue**: `save_issue` with a title and markdown description. Set the team,
  and a status/label if the skill's role calls for one (see `triage-labels.md`).
- **Read an issue**: `get_issue` by ID, then `list_comments` for discussion.
- **List / find issues**: `list_issues` filtered by team, status, label, or assignee.
- **Comment on an issue**: `save_comment` against the issue ID.
- **Apply / remove labels**: `save_issue` updating the label set; discover valid labels
  with `list_issue_labels` and valid workflow states with `list_issue_statuses`.
- **Close / resolve**: move the issue to a Done/Cancelled state via `save_issue`.

## When a skill says "publish to the issue tracker"

Create a Linear issue.

## When a skill says "fetch the relevant ticket"

`get_issue` for the referenced Linear issue ID, plus `list_comments`.

## Pull requests as a triage surface

**No.** External PRs are not treated as feature requests here — GitHub is code-and-PRs
only, and requests are captured directly as Linear issues. `/triage` should not pull PRs
into the queue.

## Mapping the canonical triage roles onto Linear

Linear separates **workflow state** (Triage / Backlog / Todo / In Progress / Done /
Cancelled) from **labels**. The five canonical roles in `triage-labels.md` are applied as
Linear labels by default. If you later prefer to express some of them as workflow states
instead (e.g. `needs-triage` → the Triage state, `wontfix` → Cancelled), update
`triage-labels.md` to record that mapping so the skills apply the right thing.
