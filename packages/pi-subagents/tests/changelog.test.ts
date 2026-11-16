import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ChangelogEntry = { major: number; minor: number; patch: number; content: string };

// Exercise Pi's installed parser without copying its version-selection logic.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { parseChangelog, getNewEntries } = await import(new URL("./utils/changelog.js", sdkEntry).href) as {
  parseChangelog(path: string): ChangelogEntry[];
  getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] | undefined;
};
const packageRoot = new URL("../", import.meta.url);
const changelogPath = fileURLToPath(new URL("CHANGELOG.md", packageRoot));
const metadata = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as {
  version: string;
};

function versionOf(entry: ChangelogEntry): string {
  return `${entry.major}.${entry.minor}.${entry.patch}`;
}

describe("package changelog startup compatibility", () => {
  it("shows no updates on two consecutive startups at the installed version", () => {
    let lastVersion = metadata.version;
    for (let startup = 0; startup < 2; startup++) {
      const updates = getNewEntries(parseChangelog(changelogPath), lastVersion);
      expect(updates?.length).toBe(0);
      if (updates?.length) lastVersion = metadata.version;
    }
  });

  it("shows only subsequent package releases when upgrading from each recorded version", () => {
    const entries = parseChangelog(changelogPath);
    expect(entries.length).toBeGreaterThan(1);
    expect(versionOf(entries[0])).toBe(metadata.version);
    for (const [index, entry] of entries.entries()) {
      const updates = getNewEntries(entries, versionOf(entry));
      expect(updates?.map(versionOf)).toEqual(entries.slice(0, index).map(versionOf));
    }
  });
});
