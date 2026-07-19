# TODOS

## Publishing

### Enable live publishing to configured user repositories

**What:** Connect the proven sealed-plan executor to explicitly configured real repositories.

**Why:** Preview and disposable Git proof do not complete MDX Relay’s end-to-end product promise.

**Context:** The first safety slice proves journaling, private-index tree construction, compare-and-swap ref updates, push classification, and recovery only in disposable repositories with local bare remotes. After every first-slice unit, fault-injection, packaged smoke, and disposable Git test passes, expose the same executor for a reviewed machine-local binding. Do not weaken any fingerprint, redaction, lock, rollback, or remote-verification rule.

**Effort:** L
**Priority:** P1
**Depends on:** First safety slice accepted on macOS

### Add a second publishing profile

**What:** Add one generic profile and fixture that changes repository/output conventions without changing core code.

**Why:** `dpw-mind-net-v1` proves one workflow; a second profile proves the schema is genuinely portable.

**Context:** Keep framework adapters and arbitrary profile code out of scope. Start only after the private baseline, sanitized public fixture, and first live publish pass. The new profile must use the same declarative schema and compatibility tests.

**Effort:** M
**Priority:** P2
**Depends on:** First live publish milestone

## Platform and Release

### Add Windows 11 and Ubuntu adapters

**What:** Implement platform storage, filesystem durability, process-tree cancellation, path semantics, and packaged fault tests for Windows 11 and Ubuntu 24.04.

**Why:** The approved design requires both platforms before Obsidian Community Plugin submission.

**Context:** macOS is the alpha proving ground. Port only after its durability and recovery contract passes. Preserve owner-only storage, path-alias rejection, exact Git modes, and release-archive inspection on every platform.

**Effort:** XL
**Priority:** P1
**Depends on:** macOS alpha accepted

## Performance and Privacy

### Reassess configurable processing limits from alpha evidence

**What:** Decide whether safe user-configurable limits are needed after measuring real alpha workloads.

**Why:** Fixed limits may block legitimate large posts, but configurable limits can let users freeze Obsidian or create unsupported recovery loads.

**Context:** Record only local duration, file-count, byte-count, decoded-pixel, timeout, and limit-hit measurements. Never record note/image content. Current fixed limits remain authoritative until evidence justifies a settings design.

**Effort:** M
**Priority:** P3
**Depends on:** macOS alpha usage evidence

### Reassess sealed-blob encryption before Community submission

**What:** Run a threat-model review and add OS-backed encryption only if backups, shared machines, or managed-device policy require it.

**Why:** Owner-only files and outside-sync placement protect the alpha without creating premature Keychain/DPAPI/Secret Service complexity, but broader distribution may change the threat model.

**Context:** Alpha storage is outside vault/repository/sync roots, uses `0700` directories and `0600` files, redacts logs, retains successful artifacts for seven days, and visibly discloses local temporary copies. Custom encryption must include recovery, migration, uninstall, and cross-platform key-loss behavior before adoption.

**Effort:** L
**Priority:** P3
**Depends on:** Alpha threat-model review; platform-adapter design

## Completed
