---
name: verify
description: Run before marking any task complete. Uses the real project commands once configured; the scaffold gate currently verifies repository structure only.
---

# verify

Run every step in order. Do not claim completion until all applicable checks pass.

## Step 1: Scaffold check

Until the first engineering slice creates `package.json`, run:

```bash
python3 - <<'PY'
from pathlib import Path
required = ['README.md', 'LICENSE', 'PITCH.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'WORKING_AGREEMENT.md', 'WORKING_AGREEMENT.apps.md', 'GIT_CONVENTIONS.md']
missing = [p for p in required if not Path(p).is_file()]
if missing:
    raise SystemExit(f'missing: {missing}')
print(f'scaffold: {len(required)} required files present')
PY
```

Required: exit code 0.

Once `package.json` exists, this section must be replaced with the real install/check/build commands from the approved engineering plan.

## Step 2: Automated tests

No test framework is configured in the pre-implementation scaffold.

Report exactly:

```text
Tests: skipped — no test framework configured.
```

The first engineering slice must replace this with the real test command before adding product behavior.

## Step 3: Acceptance criteria

Read the active task's acceptance criteria. Confirm each item against real files, command output, or remote URLs.

## Step 4: Evidence

Output the commands, exit codes, test counts or explicit skip reason, and acceptance evidence. No “should work” or “looks good.”
