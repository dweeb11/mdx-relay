# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
actual label strings used in this repo's issue tracker (Linear).

| Role in mattpocock/skills | In our tracker (Linear)          | Meaning                                  |
| ------------------------- | -------------------------------- | ---------------------------------------- |
| `needs-triage`            | **`Triage` workflow state**      | Maintainer needs to evaluate this issue  |
| `needs-info`              | `needs-info` label               | Waiting on reporter for more information |
| `ready-for-agent`         | `ready-for-agent` label          | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | `ready-for-human` label          | Requires human implementation            |
| `wontfix`                 | `wontfix` label                  | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding mapping from this table.

**`needs-triage` is a workflow STATE, not a label** (decided 2026-07-24): file issues
awaiting evaluation with `state: "Triage"` and do NOT apply a `needs-triage` label — the
label exists in the workspace but is not used for this repo. The other four roles are
Linear labels; discover the workspace's actual labels with `list_issue_labels` before
applying. A role label may coexist with the Triage state (e.g. an issue can sit in Triage
already carrying `ready-for-agent`).
