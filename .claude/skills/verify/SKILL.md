---
name: verify
description: Run the complete MDX Relay install, static-check, test, and bundle gate before marking any task complete.
---

# verify

Run every step in order from the repository root. Do not claim completion until all applicable checks pass.

## Step 1: Reproducible install

```bash
node --version
npm --version
npm ci
```

Required: Node 22.x, a lockfile-backed install, and exit code 0.

## Step 2: Full public gate

```bash
npm run verify
```

`verify` runs formatting, ESLint contract-boundary enforcement, TypeScript, unit coverage, integration tests, and the production bundle check. Integration lanes that have not landed yet use Vitest's explicit `--passWithNoTests`; the command must still run and report that no tests were found. The bundle check builds `dist/main.js` and fails if any native `.node` artifact exists.

## Step 3: Direct task gates

For T0 and any contract/toolchain change, also show each required command independently:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Inspect release output directly:

```bash
find dist -type f -name '*.node' -print
```

Required: every command exits 0 and the direct `.node` search prints nothing.

## Step 4: Private baseline when available

T7 supplies the external fixture resolver and test. Until then, this command honestly reports Vitest's no-tests-yet result:

```bash
npm run test:private-baseline
```

Once T7 lands, set `MDX_RELAY_PRIVATE_FIXTURE_ROOT` to the approved machine-local fixture root and require passing tests. Never copy private fixture bytes into the repository, coverage, logs, or reports.

## Step 5: Acceptance evidence

Read the active task's acceptance criteria and report:

- commands and exit codes;
- exact passed/failed/skipped test counts from real output;
- coverage summary;
- direct bundle inspection result;
- each acceptance item mapped to `file:line`;
- `git status --short --branch`.

No “should work” or “looks good.”
