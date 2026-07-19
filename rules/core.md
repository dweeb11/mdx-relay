---
description: Standards for core systems — stability, performance, clean APIs
globs: src/core/**
---

# Core Systems Standards

- Zero allocations in hot paths (per-frame code). Pre-allocate buffers, pool objects, avoid creating arrays/dicts in `_process` or `_physics_process`.
- Public APIs must be stable. Changing a core system's interface requires updating all callers in the same commit. No breaking changes left for "later."
- Thread safety must be explicit. If a core system can be accessed from multiple threads, document it and use appropriate synchronization.
- Core systems must not depend on gameplay code. Dependencies flow inward: gameplay → core, never core → gameplay.
