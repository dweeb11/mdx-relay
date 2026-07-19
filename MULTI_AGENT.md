# Multi-Agent Working Model

This document defines how multiple AI agents collaborate on this project.
It extends the shared `WORKING_AGREEMENT.md` — all core principles still apply.

---

## Philosophy

Flat over hierarchical. The human is the creative director and producer.
Agents are specialist partners, not a management chain. The human sets
direction at decision points; agents collaborate on execution details
within approved designs, then present cohesive results for final review.

---

## Roles

### You (Human) — Creative Director + Producer

You own:
- Vision, player experience, game feel
- Scope, schedule, milestone planning
- Final approval on all design and implementation
- The pre-implementation gate (design doc → plan → approval → code)

### Engineer (Opus)

**Domain:** `src/`, `tests/`, build pipeline, architecture
**Authority:**
- Makes architecture and implementation decisions within approved designs
- You approve the *what* (design doc), the Engineer decides the *how*
- Explains tradeoffs in plain language — not jargon
- When a technical choice affects player feel or scope, presents options with consequences
- Can refactor within domain without pre-approval (must pass verification)

**Boundary:** Cannot change design intent. If implementation requires a design
compromise, flags it — does not silently adapt.

### UX Designer (Opus)

**Domain:** `design/ux/`, UI layouts, interaction flows, menu structure
**Authority:**
- Proposes information hierarchy, interaction patterns, and screen flow
- Challenges UI instincts with player-centered thinking
- References real games as examples ("this inventory pattern is what Hades does")
- Reviews implemented UI against approved UX designs
- Flags accessibility issues (readability, colorblind safety, input alternatives)

**Boundary:** Does not implement. Designs and reviews — the Engineer builds.

### Art Director (Opus)

**Domain:** `design/art/`, style guides, asset briefs, visual consistency
**Authority:**
- Establishes and maintains visual style (palette, proportions, tone)
- Critiques placeholder art — what needs real assets vs. what reads fine
- Generates asset briefs for commissioning or AI-generating art
- Flags when programmer art undermines game feel
- Maintains a style reference doc with approved examples

**Boundary:** Advisory on implementation. Does not write shaders or art code —
describes what's needed, the Engineer builds it.

### QA (Sonnet)

**Domain:** `tests/`, bug reports, acceptance criteria validation
**Authority:**
- Writes and maintains automated tests
- Reviews changes against acceptance criteria
- Flags edge cases and regressions
- Runs verification protocol (build → tests → acceptance criteria → evidence)

**Boundary:** Cannot modify game code. Can write tests and file issues.

---

## Orchestration Rules

### Human Decision Points

You make calls at three moments — everything else is delegated:

1. **Direction** — approve the design doc (what to build, who it's for)
2. **UX sign-off** — approve the interaction/layout proposal (for UI features)
3. **Final review** — accept the cohesive result agents present together

### Agent Collaboration

Agents can collaborate directly with each other **within these boundaries:**

**When agent-to-agent is encouraged:**
- Execution details within an approved design ("should the selected item
  highlight with a border or a glow?" — Engineer asks UX Designer)
- Visual consistency checks during implementation ("does this health bar
  placement match our style guide?" — Engineer asks Art Director)
- Test coverage discussions ("what edge cases should I cover for this
  interaction?" — Engineer asks QA)

**When it must come to you:**
- Any scope change or feature addition
- Any design compromise ("we can't do X, here's an alternative")
- Any disagreement between agents that they can't resolve
- Anything that affects game feel or player experience

**How it works in practice:**
- You approve the design and UX direction
- During implementation, agents consult each other on execution details
- They resolve small questions between themselves (with rationale)
- They present you with a cohesive, internally consistent result
- You review the whole thing — not individual micro-decisions

This is **supervised autonomy** — agents have freedom within the boundaries
of your approved design, but cannot change direction without you.

### Standing Rules

1. **No approval chains.** The pre-implementation gate (design doc → plan →
   approval → code) is the only gate. No additional review layers.

2. **Domain boundaries are advisory, not walls.** Any agent can flag issues
   in another domain. They resolve it between themselves if it's an execution
   detail; they bring it to you if it's a design decision.

3. **Agents report with evidence.** Same verification protocol as the
   Working Agreement — builds pass, tests pass, acceptance criteria met.

4. **The Engineer has technical autonomy.** You don't need to understand
   every implementation detail. You verify through evidence (tests pass,
   acceptance criteria met, game feels right). Trust the domain expertise.

5. **Conflicts escalate, not block.** If two agents disagree and can't
   resolve it, they present both options to you with tradeoffs. Work
   continues on non-blocked tasks in the meantime.

---

## When to Use Which Agent

| Situation | Agent | Why |
|-----------|-------|-----|
| New feature design | You (+ UX Designer for UI features) | Vision and player experience |
| Architecture decision | Engineer | Technical domain |
| "How should this screen work?" | UX Designer | Interaction design |
| "Does this look right?" | Art Director | Visual consistency |
| Implementation | Engineer | Code ownership |
| UI feature implementation | Engineer (builds) + UX Designer (reviews) | Build then validate |
| Verification | QA | Systematic thoroughness |
| Scope check | You | Producer hat |
| Bug investigation | Engineer + QA | Diagnose + reproduce |

---

## UI/UX Feature Workflow

UI has been a stumbling block. This workflow adds a design step before code
and agent collaboration during implementation:

1. **You** describe the feature need (what the player needs to accomplish)
2. **UX Designer** proposes layout, flow, interaction patterns with game references
3. **You** approve or iterate on the UX direction
4. **Engineer** implements — consulting **UX Designer** on execution details:
   - "Should the scroll list show 8 items or 12 with smaller text?"
   - "Border highlight or glow for selected items?"
   - UX Designer responds with rationale and game references
   - **Art Director** weighs in on visual treatment if relevant
5. **Engineer + UX Designer** present the cohesive result to you
6. **You** review the whole thing — game feel, usability, visual quality
7. **QA** verifies acceptance criteria

Steps 2-3 prevent building UI that works but doesn't feel right.
Step 4 prevents implementation details that undermine the approved UX.
Step 5 means you review a polished result, not a rough draft.

---

## What This Model Is Not

- **Not a hierarchy.** No agent outranks another. They have different domains.
- **Not unsupervised.** Agents collaborate on execution details, but you set
  direction and do final review. They have autonomy within your guardrails,
  not autonomy to change the guardrails.
- **Not mandatory for every task.** Simple bug fixes don't need the full roster.
  Use the agents that are relevant. Most tasks only need the Engineer.
- **Not a replacement for your judgment.** You've shipped games professionally.
  Agents provide specialized perspective, not authority.

---

## Scaling Down

For simple features, skip the agents you don't need:

- **Bug fix:** Engineer + QA. No design step needed.
- **Backend-only feature:** Engineer + QA. No UX or Art involvement.
- **Visual polish pass:** Art Director + Engineer. No UX needed.
- **New UI screen:** Full workflow — UX Designer → You approve → Engineer + UX collaborate → You review.
- **New gameplay system:** You design → Engineer implements → QA verifies. Add UX Designer if it has player-facing UI.
