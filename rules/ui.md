---
description: Standards for UI code — no game state ownership, accessibility, localization
globs: src/ui/**
---

# UI Code Standards

- UI does not own game state. It reads and displays. State changes go through signals/events back to the owning system.
- All text must be localization-ready. No hardcoded user-facing strings — use string keys or a localization system from the start.
- Interactive elements must have clear hover/focus/pressed states. Players need to know what's clickable and what they've selected.
- Font sizes must be readable at target resolution. Minimum 16px equivalent for body text, 12px for secondary labels.
- Consider colorblind safety. Never use color alone to convey information — pair with icons, labels, or patterns.
- Keyboard/controller navigation must work for all menus. No mouse-only interactions in shipped UI.
