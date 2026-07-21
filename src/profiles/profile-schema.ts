export interface PortableRepositoryRules {
  readonly remote: string;
  readonly branch: string;
}

export interface PortableOutputRules {
  readonly contentRoot: string;
  readonly assetRoot: string;
  readonly assetUrlTemplate: string;
}

export interface PortableDocumentRules {
  readonly preset: "dpw-mind-net-v1";
  readonly wikilinks: "flatten";
  readonly callouts: "blockquote";
  readonly frontmatterPreset: "dpw-post-v1";
}

export interface PortableImageRules {
  readonly component: string;
  readonly filenameTemplate: string;
  readonly maxDimension: number;
  readonly webpQuality: number;
}

export interface PortableCommitRules {
  readonly message: string;
}

/** Declarative publishing rules only. Machine paths and repository URLs do not belong here. */
export interface PortableProfileV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly repository: PortableRepositoryRules;
  readonly output: PortableOutputRules;
  readonly document: PortableDocumentRules;
  readonly images: PortableImageRules;
  readonly commit: PortableCommitRules;
}
