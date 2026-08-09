import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRIVATE_FIXTURE_ENV = "MDX_RELAY_PRIVATE_FIXTURE_ROOT";
export const PRIVATE_MANIFEST_FILENAME = "manifest.json";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export const hasPrivateBaselineConfiguration = (env = process.env) => {
  const configured = env[PRIVATE_FIXTURE_ENV];
  return typeof configured === "string" && configured.length > 0;
};

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const safeRelativePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

const contained = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

export function validatePrivateBaselineManifest(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "files",
      "source",
      "expectedOutputs",
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !value.files.every(safeRelativePath) ||
    new Set(value.files).size !== value.files.length ||
    !exactKeys(value.source, ["note", "images"]) ||
    !safeRelativePath(value.source.note) ||
    !Array.isArray(value.source.images) ||
    !value.source.images.every(
      (image) =>
        exactKeys(image, ["sourceId", "path", "embedSource"]) &&
        typeof image.sourceId === "string" &&
        image.sourceId.length > 0 &&
        safeRelativePath(image.path) &&
        typeof image.embedSource === "string" &&
        image.embedSource.length > 0,
    ) ||
    !isRecord(value.expectedOutputs) ||
    Object.keys(value.expectedOutputs).length === 0 ||
    !Object.entries(value.expectedOutputs).every(
      ([path, digest]) => safeRelativePath(path) && SHA256.test(digest),
    )
  )
    throw new Error("Invalid private baseline manifest.");
  const requiredSources = [
    value.source.note,
    ...value.source.images.map((image) => image.path),
  ];
  if (!requiredSources.every((path) => value.files.includes(path)))
    throw new Error("Private baseline source is missing from the file list.");
  return Object.freeze({
    schemaVersion: 1,
    files: Object.freeze([...value.files]),
    source: Object.freeze({
      note: value.source.note,
      images: Object.freeze(
        value.source.images.map((image) => Object.freeze({ ...image })),
      ),
    }),
    expectedOutputs: Object.freeze({ ...value.expectedOutputs }),
  });
}

export async function resolvePrivateBaseline(env = process.env) {
  if (!hasPrivateBaselineConfiguration(env))
    return Object.freeze({
      kind: "unset",
      message: `Set ${PRIVATE_FIXTURE_ENV} to run the private baseline.`,
    });
  const configured = env[PRIVATE_FIXTURE_ENV];
  const root = await realpath(configured);
  if (!(await stat(root)).isDirectory())
    throw new Error("Private baseline root is not a directory.");
  const manifestPath = join(root, PRIVATE_MANIFEST_FILENAME);
  const manifest = validatePrivateBaselineManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  for (const file of manifest.files) {
    const resolved = await realpath(join(root, file));
    if (!contained(root, resolved) || !(await stat(resolved)).isFile())
      throw new Error("Private baseline file escapes the fixture root.");
  }
  return Object.freeze({ kind: "resolved", root, manifest });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const resolved = await resolvePrivateBaseline();
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
}
