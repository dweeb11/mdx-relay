# astro-blog-v1 — second built-in profile spec

Pinned spec for the second built-in portable profile: an Astro
content-collections blog, public-assets variant. Produced by the wayfinder
effort "Second built-in profile candidates" (APP-687); this document is the
handoff to implementation. Evidence: the
[content-contract research](https://linear.app/critterhaus/document/astro-blog-v1-content-contract-40cbbac12ef3)
and the validated scaffold at `~/projects/sandbox/astro-blog-sample`
(official Astro blog starter; all claims below verified against real builds).

## Target contract

A stock Astro v5 blog (official `--template blog` starter) with:

- Content at `src/content/blog/{slug}.mdx` (flat file; entry ids derive from
  filenames, so no site-side work is needed).
- Frontmatter validated by the user's `content.config.ts`:
  `title` (string), `description` (string), `pubDate` (coerced date) required
  and build-failing when missing; `updatedDate`, `heroImage` optional.
- Assets served from `public/`; plain markdown images against absolute
  `/blog/...` URLs work with zero site wiring (Astro copies them through
  unoptimized — fine, the plugin's pipeline already resizes and
  webp-compresses).
- Zod strips unknown frontmatter keys by default, so emitting `tags` against
  a schema that does not declare it is safe. Sites using `.strict()` are out
  of contract.

## Profile literal

```ts
export const ASTRO_BLOG_V1 = {
  schemaVersion: 1,
  id: "astro-blog-v1",
  name: "Astro Blog",
  output: {
    contentRoot: "src/content/blog",
    assetRoot: "public/blog",
    assetUrlTemplate: "/blog/{slug}/{assetFile}",
  },
  document: {
    preset: "astro-blog-v1",
    wikilinks: "flatten",
    callouts: "blockquote",
    frontmatterPreset: "astro-blog-v1",
  },
  images: {
    emit: "markdown",
    filenameTemplate: "img-{index}.webp",
    maxDimension: 2000,
    webpQuality: 85,
  },
} as const satisfies PortableProfileV1;
```

## Schema changes (v1-compatible growth, no v2)

1. **Preset enums.** `document.preset` and `document.frontmatterPreset` stop
   being pinned literals and become enums over a preset registry:
   `"dpw-mind-net-v1" | "astro-blog-v1"` and `"dpw-post-v1" | "astro-blog-v1"`.
   `parsePortableProfile` accepts both members; the frontmatter module splits
   into per-preset field mapping + serialization; the Blocked-state guidance
   report (APP-683) becomes preset-driven.
2. **Image emission mode.** New `images.emit: "markdown" | "component"` field.
   **Variant shape** (decided): `images.component` exists only when
   `emit: "component"`; a markdown-mode profile must not carry the key, and
   `hasExactKeys` is checked per variant. `dpw-mind-net-v1` gains
   `emit: "component"` and keeps its `component` field.
3. **Markdown emission** produces `![{alt}]({assetUrl})`, carrying the source
   image's alt text through (component mode's `alt=""` wart is not inherited).
   The only image source syntax is the Obsidian embed `![[file|suffix]]`, and
   its pipe suffix is not always alt text — Obsidian also uses it for display
   sizing. Classification of the suffix (everything after the first `|`,
   trimmed):
   - Matches `^\d+$` (width) or `^\d+x\d+$` (width×height) → **resize hint**:
     ignored for emission (display sizing is the site's concern), and the
     image counts as having no alt text.
   - Anything else → **alt text**, escaped with the same MDX-safety rules as
     wikilink alias text.
   - No suffix, or an empty/whitespace suffix → no alt text.
   Images without alt text emit `![]({assetUrl})` and surface the existing
   missing-alt warning; a resize hint must never be published as alt text.
4. `wikilinks`/`callouts` stay pinned literals — nothing here unpins them.
5. Forward-compatibility caveat: `hasExactKeys` means plugin versions predating
   `images.emit` hard-reject profiles that carry it. The stance on that is
   owned by the profile-format work on the beta map (APP-680), not this spec.

## Frontmatter preset `astro-blog-v1`

Field mapping from the parsed source note:

| Source (`DpwPostFrontmatter`) | Emitted | Rule |
|---|---|---|
| `title` | `title` | plain YAML scalar (same serializer style as `dpw-post-v1`) |
| `summary` | `description` | plain YAML scalar |
| `date` | `pubDate` | quoted string, **passed through verbatim** (decided): no reformatting; the guidance report flags an unparseable date as a blocker |
| `labels` | `tags` | flow sequence; **omitted entirely when empty** (decided) |
| `topic`, `msg`, `read` | — | dropped |
| — | `heroImage` | **never emitted**: the stock schema validates it with `image()`, which rejects public-URL strings |

Sample emitted frontmatter:

```yaml
---
title: Getting started with MDX Relay
description: How approved notes and their images become exact MDX files under a target folder.
pubDate: "2026-08-16"
tags: [tools, publishing]
---
```

Blockers for the frontmatter guidance report under this preset: missing/empty
`title`, `date`, or `summary` (all three map to Astro build-failing fields).

## Validated sample output

`src/content/blog/getting-started-with-mdx-relay.mdx` in the scaffold is the
reference output for a representative note (markdown image with alt text,
blockquote callout, flattened wikilink, list, inline code). `npm run build`
renders it with the image tag emitted verbatim
(`<img src="/blog/getting-started-with-mdx-relay/img-1.webp" alt="Diagram of the export pipeline"/>`).

## Out of contract (consciously)

- Colocated `src/` assets with relative paths / ESM image imports.
- Folder-per-post output naming; anything but `{contentRoot}/{slug}.mdx`.
- `heroImage`, structured `authors`, admonition callouts.
- Sites that add `.strict()` to their collection schema and reject `tags`.
