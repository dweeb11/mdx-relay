import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  engines: { node: string };
  devDependencies: { "@types/node": string };
}

interface PackageLock {
  packages: Record<
    string,
    {
      version?: string;
      devDependencies?: { "@types/node"?: string };
    }
  >;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as PackageManifest;
const packageLock = JSON.parse(
  readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"),
) as PackageLock;

describe("Node type definitions", () => {
  it("stay on the single Node major supported at runtime", () => {
    const engineMatch = /^>=(\d+) <(\d+)$/.exec(packageJson.engines.node);
    expect(engineMatch).not.toBeNull();

    const minimumMajor = Number(engineMatch?.[1]);
    const excludedMajor = Number(engineMatch?.[2]);
    expect(excludedMajor).toBe(minimumMajor + 1);

    const rootPackage = packageLock.packages[""];
    const nodeTypesPackage = packageLock.packages["node_modules/@types/node"];
    if (rootPackage === undefined || nodeTypesPackage === undefined) {
      throw new Error(
        "package-lock.json is missing the @types/node package entries",
      );
    }

    const declaredVersion = packageJson.devDependencies["@types/node"];
    expect(declaredVersion).toMatch(
      new RegExp(`^${minimumMajor}\\.\\d+\\.\\d+$`),
    );
    expect(rootPackage.devDependencies?.["@types/node"]).toBe(declaredVersion);
    expect(nodeTypesPackage.version).toBe(declaredVersion);
  });
});
