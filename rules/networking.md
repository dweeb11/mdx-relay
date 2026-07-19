---
description: Standards for networking code — server-authoritative, security-first
globs: src/networking/**
---

# Networking Code Standards

- Server-authoritative by default. The client requests actions, the server validates and executes. Never trust client state.
- All network messages must be versioned. Include a version field so old clients can be detected and handled gracefully.
- Validate all incoming data. Assume every message could be malformed or malicious. Bounds-check, type-check, reject invalid payloads.
- Never send secrets (tokens, keys, internal IDs) to the client.
- Handle disconnection and reconnection gracefully. Every networked system must define what happens when the connection drops mid-operation.
