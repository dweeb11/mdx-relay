import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import process from "node:process";

import * as esbuild from "esbuild";

const mode = process.argv[2];
const production = mode === "production";
const nodeBuiltinExternals = [
  ...new Set(
    builtinModules.flatMap((moduleName) => {
      const bareName = moduleName.startsWith("node:")
        ? moduleName.slice("node:".length)
        : moduleName;
      return [bareName, `node:${bareName}`];
    }),
  ),
];
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...nodeBuiltinExternals,
];
const sharedBuildOptions = {
  bundle: true,
  external,
  format: "cjs",
  target: "es2021",
  platform: "browser",
  treeShaking: true,
  define: {
    "import.meta.vitest": "undefined",
  },
};

if (mode === "probe-node-builtins") {
  const result = await esbuild.build({
    ...sharedBuildOptions,
    stdin: {
      contents:
        'import fs from "node:fs"; import path from "path"; void fs; void path;',
      loader: "ts",
      sourcefile: "node-builtins-probe.ts",
    },
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap(({ imports }) => imports)
    .filter(({ external: isExternal }) => isExternal)
    .map(({ path }) => path)
    .sort();
  assert.deepEqual(externalImports, ["node:fs", "path"]);
  process.stdout.write(
    `bundle probe: Node built-ins remain external (${externalImports.join(", ")})\n`,
  );
} else {
  const context = await esbuild.context({
    ...sharedBuildOptions,
    entryPoints: ["src/main.ts"],
    sourcemap: production ? false : "inline",
    minify: production,
    outfile: "dist/main.js",
    logLevel: "info",
  });

  if (production) {
    await context.rebuild();
    await context.dispose();
  } else {
    await context.watch();
  }
}
