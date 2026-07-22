import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Node,
} from "yaml";

import {
  createIssue,
  ISSUE_CODES,
  type MdxRelayIssue,
} from "../contracts/issues";
import { err, ok, type Result } from "../contracts/result";

export interface DpwPostFrontmatter {
  readonly title: string;
  readonly date: string;
  readonly summary: string;
  readonly labels: readonly string[];
  readonly topic: string;
  readonly msg: string;
  readonly read: string;
}

export interface ParsedFrontmatter {
  readonly slug: string;
  readonly frontmatter: string;
  readonly body: string;
  readonly bodyOffset: number;
  readonly metadata: DpwPostFrontmatter;
  readonly warnings: readonly MdxRelayIssue[];
}

export interface FrontmatterOptions {
  readonly existingMessages?: readonly string[];
}

const invalidFrontmatter = (): Result<never, MdxRelayIssue> =>
  err(createIssue(ISSUE_CODES.invalidFrontmatter));

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[\u0027\u2018\u2019]/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

const yamlScalar = (value: string): string => stringify(value).trimEnd();

const inlineYamlScalar = (value: string): string =>
  value.includes("\n") || value.includes("\r")
    ? JSON.stringify(value)
    : yamlScalar(value);

const quotedScalar = (value: string): string => JSON.stringify(value);

export function serializeFrontmatter(data: DpwPostFrontmatter): string {
  return [
    "---",
    `title: ${yamlScalar(data.title)}`,
    `date: ${quotedScalar(data.date)}`,
    `summary: ${yamlScalar(data.summary)}`,
    `labels: [${data.labels.map(inlineYamlScalar).join(", ")}]`,
    `topic: ${yamlScalar(data.topic)}`,
    `msg: ${quotedScalar(data.msg)}`,
    `read: ${yamlScalar(data.read)}`,
    "---",
  ].join("\n");
}

const stringField = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

const hasUnsafeYamlNode = (node: Node | null | undefined): boolean => {
  /* v8 ignore next -- recursive YAML node types permit null, but validated document children do not. */
  if (!node) return false;
  if (isAlias(node) || node.tag !== undefined) return true;
  if (isMap(node))
    return node.items.some(
      (pair) =>
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        hasUnsafeYamlNode(pair.key as Node | null | undefined) ||
        hasUnsafeYamlNode(pair.value as Node | null | undefined),
    );
  if (isSeq(node))
    return node.items.some((item) =>
      hasUnsafeYamlNode(item as Node | null | undefined),
    );
  return !isScalar(node);
};

export function parseFrontmatter(
  source: string,
  options: FrontmatterOptions = {},
): Result<ParsedFrontmatter, MdxRelayIssue> {
  const opening = /^(?:\uFEFF)?---(?:\r?\n)/u.exec(source);
  if (!opening) return invalidFrontmatter();

  const remainderStart = opening[0].length;
  const closing = /^---[ \t]*(?:\r?\n|$)/gmu;
  closing.lastIndex = remainderStart;
  const match = closing.exec(source);
  if (!match) return invalidFrontmatter();

  const yamlSource = source.slice(remainderStart, match.index);
  const document = parseDocument(yamlSource, { uniqueKeys: true });
  if (
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    !isMap(document.contents) ||
    hasUnsafeYamlNode(document.contents)
  ) {
    return invalidFrontmatter();
  }

  const record = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (
    record.date !== undefined &&
    typeof record.date !== "string" &&
    (typeof record.date !== "number" || !Number.isFinite(record.date))
  ) {
    return invalidFrontmatter();
  }
  if (
    record.labels !== undefined &&
    (!Array.isArray(record.labels) ||
      record.labels.some(
        (value) => value !== null && typeof value === "object",
      ))
  ) {
    return invalidFrontmatter();
  }

  const title = stringField(record, "title");
  const labels = Array.isArray(record.labels)
    ? record.labels.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const metadata = Object.freeze({
    title,
    date:
      typeof record.date === "string" || typeof record.date === "number"
        ? String(record.date)
        : "",
    summary: stringField(record, "summary"),
    labels: Object.freeze(labels),
    topic: stringField(record, "topic"),
    msg: stringField(record, "msg"),
    read: stringField(record, "read"),
  });
  const warnings: MdxRelayIssue[] = [];
  if (metadata.summary.trim() === "")
    warnings.push(createIssue(ISSUE_CODES.summaryMissing));
  if (metadata.msg !== "" && options.existingMessages?.includes(metadata.msg)) {
    warnings.push(createIssue(ISSUE_CODES.duplicateMessageField));
  }

  const bodyStart = match.index + match[0].length;
  return ok(
    Object.freeze({
      slug: slugify(title || "untitled"),
      frontmatter: serializeFrontmatter(metadata),
      body: source.slice(bodyStart),
      bodyOffset: bodyStart,
      metadata,
      warnings: Object.freeze(warnings),
    }),
  );
}
