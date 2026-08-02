import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("product scope documentation", () => {
  it("allows approved source content only in sealed outputs", () => {
    const adr = readFileSync(
      new URL(
        "../../../docs/adr/0003-local-target-folder-no-git.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(adr).toContain("outside the sealed approved outputs");
    expect(adr).toContain(
      "reject credentials from written output even when they appear in approved source content",
    );
    expect(adr).not.toContain(
      "private source content or credentials from leaking through profiles, plans, logs, errors, snapshots, or written output",
    );
  });
});
