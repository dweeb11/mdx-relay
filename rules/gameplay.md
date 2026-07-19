---
description: Standards for gameplay code — data-driven values, clean state management
globs: src/gameplay/**
---

# Gameplay Code Standards

- No magic numbers. All tuning values (speeds, durations, damage, thresholds) must live in exported constants, resources, or config files — never inline.
- Always use delta time for anything time-dependent. No frame-rate-coupled logic.
- State machines must be explicit. No boolean flags that implicitly track state (`is_attacking && !is_dead && has_weapon`). Use an enum or state machine pattern.
- No direct UI references. Gameplay code emits signals/events — UI listens. Never `get_node("../UI/HealthBar")` from gameplay.
- New entities must include a debug menu spawn entry (per WORKING_AGREEMENT.games.md).
