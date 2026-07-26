# JCS fixture provenance

Official RFC 8785 test vectors from
[cyberphone/json-canonicalization](https://github.com/cyberphone/json-canonicalization)
`testdata/` (`input/`, `output/`, `outhex/`).

Vendored offline for APP-629 / ADR 0002 so the suite stays reproducible without
network access. Snapshot taken from the repository's `master` branch on
2026-07-26. The large ES6 number corpus (`es6testfile100m.txt.gz`) is not
vendored; Node's `JSON.stringify` is the ES6 number serializer JCS defers to.
