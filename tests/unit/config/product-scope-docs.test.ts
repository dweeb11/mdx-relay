import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("product scope documentation", () => {
  const adr = readFileSync(
    new URL(
      "../../../docs/adr/0003-local-target-folder-no-git.md",
      import.meta.url,
    ),
    "utf8",
  );

  it("allows approved source content only in sealed outputs", () => {
    expect(adr).toContain("outside the sealed approved outputs");
    expect(adr).toContain(
      "reject credentials from written output even when they appear in approved source content",
    );
    expect(adr).not.toContain(
      "private source content or credentials from leaking through profiles, plans, logs, errors, snapshots, or written output",
    );
  });

  it("keeps the threat-model capabilities and credential authority explicit", () => {
    expect(adr).toContain(
      "The vault and plan store are distinct locations: the plan\nstore is deliberately outside the vault, repository, and known sync roots.",
    );
    expect(adr).toContain(
      "Write access to only one of those\nlocations is not assumed to imply access to the other and is insufficient",
    );
    expect(adr).toContain(
      "Ordinary source edits still\ninvalidate approval when live bytes are revalidated.",
    );
    expect(adr).toContain(
      "That exact approval bypass is the accepted local-\nadversary behavior",
    );
    expect(adr).toContain(
      "blocked in the transform core before output is sealed; approval cannot override\nthat block",
    );
  });
});
