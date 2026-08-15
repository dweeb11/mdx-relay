# Process rules (adopted from First Safety Slice retro, 2026-08-14)

## Adversarial-input pass at spec time

Every new contract, protocol message, or serialized format gets an adversarial
enumeration DURING spec review, before implementation: for each field, ask how
it could be forged, tampered, absent, empty, oversized, or replayed, and name
the rejecting guard. The slice's 16 fix commits were dominated by exactly these
cases landing a review round late (tokenless worker messages, tampered plan
IDs, empty archive payloads).

## No fixed flushes in new or touched async tests

Async tests you add or modify must never encode how long async work takes —
only what state it produces. Banned in new/touched tests: `setTimeout(n)`
waits, sleeps, counted-microtask `flush()` helpers. Required: await a
deterministic signal — `vi.waitFor` on the observable DOM/state outcome, or an
exposed completion promise. Existing suites still using counted flushes (e.g.
the JSDOM `flush()` helpers) are grandfathered; migrate them when you touch
them, with APP-676 as the tracked starting point. Precedent: APP-676, where a
two-microtask flush raced a real fs probe and flaked only under parallel
coverage load.

## PR body tone

Write PR summaries the way the local-model reviewer note does: lead with a
risk level and a short plain-English overview a human can skim, then detail.
Dense spec-language bullet walls are for docs, not PR bodies.
