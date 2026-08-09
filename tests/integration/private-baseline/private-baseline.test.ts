import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256OfBytes } from "../../../src/canonical/hash";
import { imageFixture } from "../../helpers/codec-wasm";
import { buildWorkerBackedEnvelope } from "../../helpers/export-plan";

interface PrivateManifest {
  readonly files: readonly string[];
  readonly source: {
    readonly note: string;
    readonly images: readonly {
      readonly sourceId: string;
      readonly path: string;
      readonly embedSource: string;
    }[];
  };
  readonly expectedOutputs: Readonly<Record<string, string>>;
}

type ResolverResult =
  | { readonly kind: "unset"; readonly message: string }
  | {
      readonly kind: "resolved";
      readonly root: string;
      readonly manifest: PrivateManifest;
    };

interface ResolverModule {
  readonly PRIVATE_FIXTURE_ENV: string;
  resolvePrivateBaseline(env?: NodeJS.ProcessEnv): Promise<ResolverResult>;
}

const resolver = (await import(
  new URL("../../../scripts/resolve-private-baseline.mjs", import.meta.url).href
)) as ResolverModule;

const roots: string[] = [];
const temporaryRoot = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `mdx-relay-${name}-`));
  roots.push(root);
  return realpath(root);
};

const compareFixture = async (
  root: string,
  manifest: PrivateManifest,
): Promise<void> => {
  if (manifest.source.images.length !== 1)
    throw new Error("V1 private baseline requires exactly one inline image.");
  const image = manifest.source.images[0]!;
  const targetRoot = await temporaryRoot("private-target");
  const noteBytes = new Uint8Array(
    await readFile(join(root, manifest.source.note)),
  );
  const imageBytes = new Uint8Array(await readFile(join(root, image.path)));
  const built = await buildWorkerBackedEnvelope({
    targetRoot,
    noteBytes,
    imageBytes,
    imageVaultPath: image.path,
    imageEmbedSource: image.embedSource,
  });
  if (built.envelope.state !== "ready")
    throw new Error("private baseline did not produce a ready plan");
  const actual = Object.fromEntries(
    built.envelope.plan.actions.map((action) => [
      action.targetPath,
      action.sealedOutput.contentSha256,
    ]),
  );
  expect(actual).toEqual(manifest.expectedOutputs);
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("private baseline resolver and output contract", () => {
  const configuredRoot = process.env[resolver.PRIVATE_FIXTURE_ENV];
  if (configuredRoot === undefined)
    console.info(
      `SKIP external private baseline: set ${resolver.PRIVATE_FIXTURE_ENV}.`,
    );
  const external = configuredRoot === undefined ? it.skip : it;

  external(
    `matches the external fixture from ${resolver.PRIVATE_FIXTURE_ENV}`,
    async () => {
      const resolved = await resolver.resolvePrivateBaseline();
      expect(resolved.kind).toBe("resolved");
      if (resolved.kind !== "resolved") throw new Error(resolved.message);
      await compareFixture(resolved.root, resolved.manifest);
    },
    15_000,
  );

  it("validates and compares a synthetic external-layout fixture", async () => {
    const fixtureRoot = await temporaryRoot("private-synthetic");
    const source = await readFile(
      new URL("../../fixtures/public-baseline/source-note.md", import.meta.url),
      "utf8",
    );
    const note = source.replace("sample-image.PNG", "gradient.png");
    const expectedMdx = new Uint8Array(
      await readFile(
        new URL("../../fixtures/public-baseline/expected.mdx", import.meta.url),
      ),
    );
    await writeFile(join(fixtureRoot, "source-note.md"), note);
    await writeFile(
      join(fixtureRoot, "gradient.png"),
      new Uint8Array(await imageFixture("gradient.png")),
    );
    await writeFile(join(fixtureRoot, "expected.mdx"), expectedMdx);
    const manifest = {
      schemaVersion: 1,
      files: ["source-note.md", "gradient.png", "expected.mdx"],
      source: {
        note: "source-note.md",
        images: [
          {
            sourceId: "image-1",
            path: "gradient.png",
            embedSource: "gradient.png",
          },
        ],
      },
      expectedOutputs: {
        "content/posts/a-public-examples-contract.mdx":
          sha256OfBytes(expectedMdx),
        "public/posts/a-public-examples-contract/img-1.webp":
          "sha256:56537a3799f105e50bc5e30d4723bd1b71f483ac915070f78e34d4c051dfdff6",
      },
    };
    await writeFile(
      join(fixtureRoot, "manifest.json"),
      JSON.stringify(manifest),
    );

    const resolved = await resolver.resolvePrivateBaseline({
      [resolver.PRIVATE_FIXTURE_ENV]: fixtureRoot,
    });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") throw new Error(resolved.message);
    await compareFixture(resolved.root, resolved.manifest);
  }, 15_000);
});
