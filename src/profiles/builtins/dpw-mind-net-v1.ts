import type { PortableProfileV1 } from "../profile-schema";

export const DPW_MIND_NET_V1 = {
  schemaVersion: 1,
  id: "dpw-mind-net-v1",
  name: "DPW Mind Net",
  repository: {
    remote: "origin",
    branch: "main",
  },
  output: {
    contentRoot: "content/posts",
    assetRoot: "public/posts",
    assetUrlTemplate: "/posts/{slug}/{assetFile}",
  },
  document: {
    preset: "dpw-mind-net-v1",
    wikilinks: "flatten",
    callouts: "blockquote",
    frontmatterPreset: "dpw-post-v1",
  },
  images: {
    component: "PostImage",
    filenameTemplate: "img-{index}.webp",
    maxDimension: 2000,
    webpQuality: 85,
  },
  commit: {
    message: "Publish {title}",
  },
} as const satisfies PortableProfileV1;
