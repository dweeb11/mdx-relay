---
description: Standards for test code — naming, structure, coverage expectations
globs: tests/**
---

# Test Code Standards

- Test names describe the behavior, not the method: `test_player_dies_when_health_reaches_zero`, not `test_take_damage`.
- One assertion per concept. A test can have multiple asserts if they verify the same behavior, but don't test unrelated things in one function.
- Tests must be independent. No test should depend on another test's state or execution order.
- Use descriptive failure messages. When a test fails, the output should tell you what went wrong without reading the test code.
- Fixtures and helpers go in a shared test utilities file, not duplicated across test files.
- Edge cases are not optional. Zero, negative, overflow, empty collections, and null/nil inputs must be covered for any public API.
