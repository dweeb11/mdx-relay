# MDX Relay

MDX Relay converts approved Obsidian notes and their inline images into
profile-specific MDX, previews a sealed export plan, then performs narrow
verified Git operations. Its whole safety model rests on byte-exact hashing, so
this glossary is deliberately strict about the words for bytes, hashes, and
identity.

## Language

### Bytes and identity

**Canonicalization**:
Turning a JSON data value into exactly one string of bytes, so that equal values
always produce equal bytes. MDX Relay uses RFC 8785 (JCS) and nothing else.
_Avoid_: serialization, stringification, normalization

**Canonical bytes**:
The output of canonicalization. Hashed to establish identity of structured JSON
values — identity manifests, stored snapshot text, and other plain-data graphs.
Not used for raw note, image, or sealed-blob content.

**Content bytes**:
Raw note, image, and sealed-blob octets as captured or sealed. Never
canonicalized; hashed directly as they stand.

**Content-byte digest**:
A digest of content bytes (`contentSha256`). Stale-source checks rehash live
note and image bytes against the plan's recorded digests and lengths; sealed-blob
verification rehashes each blob's bytes against its record key, digest, length,
and content-addressed path.

**Digest**:
The `sha256:<lowercase-hex>` form of a SHA-256 hash. Always carries the
`sha256:` prefix; a bare hex string is not a digest. Applies to both digests of
canonical bytes and content-byte digests.
_Avoid_: hash, checksum, sum

**Snapshot**:
A canonical string captured at a moment in time and stored verbatim inside a
plan, alongside its own digest. A snapshot is text, not a hash — the plan keeps
the bytes so verification can re-derive the digest without re-canonicalizing the
original value.
_Avoid_: dump, serialized state

**Fingerprint**:
A record of captured external state that a plan is bound to, compared
structurally rather than by hash. Reserved for structured captures; when the
identity is a single hash, say **digest**.
_Avoid_: using "fingerprint" for a bare digest

**Identity manifest**:
The canonical bytes of every plan field except the generation token and the plan
ID. The thing the plan ID is the digest of.

**Plan ID**:
`plan-<hex>` — the digest of the identity manifest. The same capture always
seals to the same plan ID; a stale generation never changes it.

**Well-formed Unicode**:
A string containing no lone UTF-16 surrogate. Lone surrogates have no UTF-8
encoding, so two different ones would hash identically — every path that
canonicalizes or hashes text refuses them.

### Plans

**Draft**:
A derived plan that has no identity yet. Drafts are never trusted and never
leave the planner.

**Sealed plan**:
A draft that has been given its plan ID and has passed full verification. Only
sealing admits a plan as trusted, whether it comes from a fresh capture or from
private storage.

**Envelope**:
What sealing and verification return: the sealed plan plus its plan ID, identity
manifest, blob bytes, and whether source bytes were verified.

**Blob**:
A sealed output's content bytes, keyed by their content-byte digest. Blob paths
are the hex of that digest, so a verified plan can only ever name
content-addressed files.

**Source bytes**:
The live note and image content bytes a capture actually read. Never stored. A
plan restored from storage carries structural proof only until a live capture
supplies them again; stale-source checks then rehash those bytes against the
plan's recorded content-byte digests.

**Stale**:
Any state in which a fingerprint no longer matches what was approved. Staleness
invalidates approval; it is never repaired automatically.

### Profiles

**Portable profile**:
The shareable, machine-independent half of a profile — what to generate and
where it goes, relative to a repository.

**Machine binding**:
The machine-local half — which repository root and remote this machine resolves
a portable profile against. Never shared, never committed.

**Plain data property graph**:
A value made only of `null`, booleans, finite numbers, well-formed-Unicode
strings, plain objects, and dense plain arrays — no accessors, symbol keys,
exotic prototypes, holes, or cycles. The only kind of value this project will
canonicalize, because anything else could choose its own bytes.
