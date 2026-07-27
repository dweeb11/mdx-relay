import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CODEQL_ACTION =
  /uses:\s+github\/codeql-action\/[^@\s]+@(?<sha>[a-f0-9]{40})\s+#\s+(?<version>v\d+\.\d+\.\d+)/g;

describe("CodeQL workflow", () => {
  it("keeps every CodeQL action on the same pinned release", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/codeql.yml", import.meta.url),
      "utf8",
    );
    const pins = [...workflow.matchAll(CODEQL_ACTION)].map(({ groups }) =>
      groups ? `${groups.sha} ${groups.version}` : "",
    );

    expect(pins).toHaveLength(2);
    expect(new Set(pins).size).toBe(1);
  });
});
