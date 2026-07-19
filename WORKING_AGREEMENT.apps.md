# Working Agreement — Apps Extension

This extends the shared `WORKING_AGREEMENT.md` with conventions for
backend and fullstack applications.

---

## Fail Closed

When in doubt, block the action and surface the problem clearly.
Missing data, stale data, ambiguous input — all produce a safe
failure, never a guess.

---

## API Conventions

- Never remove or rename fields from API response schemas — they
  are the contract
- Validate all external input at the boundary
- Store timestamps in UTC; display in the user's timezone
- Strategy/business logic must be pure (no I/O) so it's testable
  in isolation
- Log errors with a request ID for traceability

---

## Secrets

- Never commit secrets, tokens, or API keys
- All environment variables require a `.env.example` entry
- Auth comparison must be constant-time
- Never log auth credentials

---

## Testing — App-Specific

The shared two-track model applies, with these additions:

**Integration tests with stubbed I/O** for business logic — fast,
no Docker required.

**E2E tests against a real database** (SQLite in dev, Postgres in CI)
for data persistence and API contract verification.

**A change is not done unless:** tests cover new logic, external inputs
are validated, errors are logged with request ID.
