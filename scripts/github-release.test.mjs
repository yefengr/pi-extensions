import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGES } from "./release.mjs";
import { createRelease, createTag, generateNotes, runCli } from "./github-release.mjs";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const TAG_SHA = "c".repeat(40);
const VERSION = "1.2.3";
const DIRECTORY = PACKAGES[0].directory;
const TAG = `${DIRECTORY}-v${VERSION}`;
const CANDIDATE = { ...PACKAGES[0], version: VERSION };
const missingRelease = () => Object.assign(new Error("release not found"), { code: 1, stderr: "release not found\n" });

function fixture(options = {}) {
  const calls = [];
  const writes = [];
  const summaries = [];
  const deps = {
    env: { GH_TOKEN: "test-only", GITHUB_REPOSITORY: "owner/repository", RUNNER_TEMP: "/runner", ...options.env },
    log: (text) => summaries.push(text),
    append: async (...args) => writes.push(args),
    readPackage: async () => CANDIDATE,
    fetchImpl: async () => Response.json(CANDIDATE),
    makeTemp: async (prefix) => { calls.push(["makeTemp", [prefix]]); return "/runner/temporary"; },
    write: async (...args) => writes.push(args),
    remove: async (...args) => calls.push(["remove", args]),
    run: async (command, args) => {
      calls.push([command, args]);
      if (options.run) return options.run(command, args);
      if (command === "git") {
        if (args[0] === "show") return { stdout: JSON.stringify(CANDIDATE) };
        if (args[0] === "for-each-ref") return { stdout: `refs/tags/${TAG}\n` };
        if (args[0] === "rev-parse") return { stdout: `${SHA}\n` };
        if (args[0] === "rev-list") return { stdout: `${SHA} ${PARENT}\n` };
        if (args[0] === "tag") return { stdout: "" };
        if (args[0] === "log") return { stdout: "- fix: 修复问题\n- feat: 新功能\n" };
      }
      if (command === "gh") {
        if (args[0] === "api") {
          if (args[1].includes("matching-refs")) return { stdout: JSON.stringify(options.refs ?? []) };
          if (args[1].endsWith(`/tags/${TAG_SHA}`)) return { stdout: JSON.stringify({ object: { type: "commit", sha: SHA } }) };
          if (args[1].endsWith("/tags")) return { stdout: JSON.stringify({ sha: TAG_SHA }) };
          if (args[1].endsWith("/refs")) return { stdout: "{}" };
        }
        if (args[1] === "view") {
          if (options.exists) return { stdout: JSON.stringify({ tagName: TAG }) };
          throw missingRelease();
        }
        if (args[1] === "create") return { stdout: "https://github.com/owner/repository/releases/tag/example" };
      }
      assert.fail(`Unexpected command: ${command} ${args.join(" ")}`);
    },
    ...options.deps,
  };
  return { deps, calls, writes, summaries };
}

const mutations = (calls) => calls.filter(([command, args]) => command === "gh" && (args.includes("POST") || args[1] === "create"));

test("package directories are allowlisted before reading or executing anything", async () => {
  for (const directory of [undefined, "", "../pi-notify", "other", "$(touch file)"]) {
    const f = fixture();
    await assert.rejects(createTag(directory, VERSION, SHA, f.deps), /allowlisted/);
    await assert.rejects(createRelease(directory, undefined, f.deps), /allowlisted/);
    assert.deepEqual(f.calls, []);
  }
});

test("only stable canonical X.Y.Z versions are accepted", async () => {
  for (const version of [null, "", "1.2", "v1.2.3", "1.2.3-beta.1", "1.2.3+build", "01.2.3", "1.2.3\n"]) {
    const f = fixture();
    await assert.rejects(createTag(DIRECTORY, version, SHA, f.deps), /X.Y.Z/);
    await assert.rejects(createRelease(DIRECTORY, version, f.deps), /X.Y.Z/);
    assert.deepEqual(f.calls, []);
  }
});

test("tag requires a full 40-character commit SHA", async () => {
  for (const commit of [undefined, "", "HEAD", "abc", "g".repeat(40), `${SHA}\n`, "-".repeat(40)]) {
    const f = fixture();
    await assert.rejects(createTag(DIRECTORY, VERSION, commit, f.deps), /40-character SHA/);
    assert.deepEqual(f.calls, []);
  }
});

test("tag reads the manifest at the staged commit and rejects version mismatch", async () => {
  const f = fixture({ run: async (command, args) => {
    assert.equal(command, "git");
    assert.deepEqual(args, ["show", `${SHA}:packages/${DIRECTORY}/package.json`]);
    return { stdout: JSON.stringify({ ...CANDIDATE, version: "1.2.2" }) };
  } });
  await assert.rejects(createTag(DIRECTORY, VERSION, SHA, f.deps), /does not match/);
  assert.equal(mutations(f.calls).length, 0);
});

test("tag rejects mismatched manifest identity and private packages", async () => {
  for (const metadata of [{ ...CANDIDATE, name: "wrong" }, { ...CANDIDATE, private: true }]) {
    const f = fixture({ run: async () => ({ stdout: JSON.stringify(metadata) }) });
    await assert.rejects(createTag(DIRECTORY, VERSION, SHA, f.deps));
    assert.equal(mutations(f.calls).length, 0);
  }
});

test("existing annotated tag at the same commit skips without mutation", async () => {
  const f = fixture({ refs: [{ ref: `refs/tags/${TAG}`, object: { type: "tag", sha: TAG_SHA } }] });
  assert.equal((await createTag(DIRECTORY, VERSION, SHA, f.deps)).status, "skipped");
  assert.equal(mutations(f.calls).length, 0);
  assert.match(f.summaries[0], /already exists/);
});

test("existing tag at another commit fails without mutation", async () => {
  const f = fixture({ refs: [{ ref: `refs/tags/${TAG}`, object: { type: "commit", sha: PARENT } }] });
  await assert.rejects(createTag(DIRECTORY, VERSION, SHA, f.deps), /another commit/);
  assert.equal(mutations(f.calls).length, 0);
});

test("new annotated tag uses GitHub tag object then ref and writes summary", async () => {
  const f = fixture({ env: { GITHUB_STEP_SUMMARY: "/summary" }, refs: [{ ref: `refs/tags/${TAG}0` }] });
  assert.equal((await createTag(DIRECTORY, VERSION, SHA, f.deps)).status, "created");
  assert.deepEqual(mutations(f.calls), [
    ["gh", ["api", "repos/owner/repository/git/tags", "--method", "POST", "-f", `tag=${TAG}`, "-f", `message=${CANDIDATE.name} ${VERSION}`, "-f", `object=${SHA}`, "-f", "type=commit"]],
    ["gh", ["api", "repos/owner/repository/git/refs", "--method", "POST", "-f", `ref=refs/tags/${TAG}`, "-f", `sha=${TAG_SHA}`]],
  ]);
  assert.equal(f.writes[0][0], "/summary");
  assert.match(f.writes[0][1], /Created annotated tag/);
});

test("all four packages use the shared allowlist", async () => {
  for (const entry of PACKAGES) {
    const candidate = { ...entry, version: VERSION };
    const tag = `${entry.directory}-v${VERSION}`;
    const f = fixture({ run: async (command) => {
      if (command === "git") return { stdout: JSON.stringify(candidate) };
      return { stdout: JSON.stringify([{ ref: `refs/tags/${tag}`, object: { type: "commit", sha: SHA } }]) };
    } });
    assert.equal((await createTag(entry.directory, VERSION, SHA, f.deps)).status, "skipped");
  }
});

test("missing release tag fails with manual recovery guidance on manual runs", async () => {
  const f = fixture({ run: async (command, args) => {
    if (command === "git" && args[0] === "for-each-ref") return { stdout: "" };
    if (command === "gh" && args[1]?.includes("matching-refs")) return { stdout: "[]" };
    return { stdout: "" };
  } });
  await assert.rejects(createRelease(DIRECTORY, undefined, f.deps), /is missing; create the annotated tag/);
  assert.equal(mutations(f.calls).length, 0);
});

test("missing release tag is skipped on scheduled runs", async () => {
  const f = fixture({ env: { GITHUB_EVENT_NAME: "schedule" }, run: async (command, args) => {
    if (command === "git" && args[0] === "for-each-ref") return { stdout: "" };
    if (command === "gh" && args[1]?.includes("matching-refs")) return { stdout: "[]" };
    return { stdout: "" };
  } });
  assert.equal((await createRelease(DIRECTORY, undefined, f.deps)).status, "missing-tag");
  assert.equal(mutations(f.calls).length, 0);
});

test("remote tag with a stale local checkout fails instead of skipping", async () => {
  const f = fixture({ run: async (command, args) => {
    if (command === "git" && args[0] === "for-each-ref") return { stdout: "" };
    if (command === "gh" && args[1]?.includes("matching-refs")) {
      return { stdout: JSON.stringify([{ ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } }]) };
    }
    return { stdout: "" };
  } });
  await assert.rejects(createRelease(DIRECTORY, undefined, f.deps), /exists on the remote but not in the local checkout/);
});

test("registry 404 skips as pending without invoking gh", async () => {
  const f = fixture({ deps: { fetchImpl: async (url) => {
    assert.equal(url, "https://registry.npmjs.org/%40yefengr%2Fpi-notify/1.2.3");
    return new Response(null, { status: 404 });
  } } });
  assert.equal((await createRelease(DIRECTORY, undefined, f.deps)).status, "pending");
  assert.ok(f.calls.every(([command]) => command !== "gh"));
});

test("registry 200 creates verified current release with notes and latest", async () => {
  const f = fixture({ env: { RUN_URL: "https://github.com/owner/repository/actions/runs/123" } });
  assert.equal((await createRelease(DIRECTORY, undefined, f.deps)).status, "created");
  assert.deepEqual(mutations(f.calls), [["gh", [
    "release", "create", TAG, "--repo", "owner/repository", "--verify-tag", "--title", `${DIRECTORY} ${VERSION}`,
    "--notes-file", `/runner/temporary/${TAG}.md`, "--latest",
  ]]]);
  assert.match(f.writes[0][1], /https:\/\/www.npmjs.com\/package\/@yefengr\/pi-notify\/v\/1.2.3/);
  assert.match(f.writes[0][1], /actions\/runs\/123/);
  assert.match(f.writes[0][1], /## 变更\n\n- fix: 修复问题\n- feat: 新功能/);
  assert.deepEqual(f.calls.at(-1), ["remove", ["/runner/temporary", { recursive: true, force: true }]]);
});

test("existing GitHub Release skips without notes or mutation", async () => {
  const f = fixture({ exists: true });
  assert.equal((await createRelease(DIRECTORY, VERSION, f.deps)).status, "skipped");
  assert.equal(mutations(f.calls).length, 0);
  assert.equal(f.writes.length, 0);
});

test("historical release is not latest; explicit current version remains latest", async () => {
  for (const currentVersion of [VERSION, "2.0.0"]) {
    const f = fixture({ deps: { readPackage: async () => ({ ...CANDIDATE, version: currentVersion }) } });
    await createRelease(DIRECTORY, VERSION, f.deps);
    assert.equal(mutations(f.calls)[0][1].at(-1), currentVersion === VERSION ? "--latest" : "--latest=false");
  }
});

test("notes skip unpublished staged tags and use nearest published package tag", async () => {
  const tags = [`${DIRECTORY}-v1.2.2`, `${DIRECTORY}-v1.2.1`, `${DIRECTORY}-v1.2.0`];
  const queried = [];
  const f = fixture({ run: async (_, args) => {
    if (args[0] === "rev-list") return { stdout: `${SHA} ${PARENT}\n` };
    if (args[0] === "tag") {
      assert.deepEqual(args, ["tag", "--merged", PARENT, "--list", `${DIRECTORY}-v*`, "--sort=-version:refname"]);
      return { stdout: [`${DIRECTORY}-v1.3.0-beta.1`, ...tags].join("\n") };
    }
    assert.deepEqual(args, ["log", "--no-merges", "--format=- %s", `${tags[1]}..${TAG}`, "--", `packages/${DIRECTORY}`]);
    return { stdout: "- feat: change\n" };
  }, deps: { fetchImpl: async (url) => {
    queried.push(url);
    return url.endsWith("1.2.2") ? new Response(null, { status: 404 }) : Response.json({ ...CANDIDATE, version: "1.2.1" });
  } } });
  const notes = await generateNotes(CANDIDATE, TAG, SHA, f.deps);
  assert.equal(queried.length, 2);
  assert.match(notes, /- feat: change/);
  assert.doesNotMatch(notes, /发布记录/);
});

test("root commit uses all history without failed parent lookup", async () => {
  const f = fixture({ run: async (_, args) => {
    if (args[0] === "rev-list") return { stdout: `${SHA}\n` };
    assert.deepEqual(args, ["log", "--no-merges", "--format=- %s", TAG, "--", `packages/${DIRECTORY}`]);
    return { stdout: "" };
  } });
  assert.match(await generateNotes(CANDIDATE, TAG, SHA, f.deps), /自 首个版本/);
});

test("registry failures and malformed 200 responses fail closed", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("offline"); },
    ...[401, 403, 429, 500, 503].map((status) => async () => new Response(null, { status })),
    async () => new Response("bad json"),
    async () => Response.json({ ...CANDIDATE, version: "wrong" }),
  ]) {
    const f = fixture({ deps: { fetchImpl } });
    await assert.rejects(createRelease(DIRECTORY, undefined, f.deps));
    assert.equal(mutations(f.calls).length, 0);
  }
});

test("previous tag registry failures cannot silently fall back to full history", async () => {
  const f = fixture({ run: async (_, args) => ({ stdout: args[0] === "rev-list" ? `${SHA} ${PARENT}` : `${DIRECTORY}-v1.2.2` }),
    deps: { fetchImpl: async () => { throw new Error("registry offline"); } } });
  await assert.rejects(generateNotes(CANDIDATE, TAG, SHA, f.deps), /registry offline/);
  assert.equal(f.calls.some(([, args]) => args[0] === "log"), false);
});

test("git and gh failures propagate, including failed release view and create", async () => {
  const cases = [
    ["git", "show"], ["gh", "api"], ["git", "for-each-ref"], ["git", "rev-parse"],
    ["git", "rev-list"], ["git", "tag"], ["git", "log"], ["gh", "view"], ["gh", "create"],
  ];
  for (const [program, operation] of cases) {
    const f = fixture();
    const original = f.deps.run;
    f.deps.run = async (command, args) => {
      if (command === program && (command === "gh" ? args[1] === operation || args[0] === operation : args[0] === operation)) {
        throw Object.assign(new Error(`${operation} offline`), { code: 1, stderr: "network failed" });
      }
      return original(command, args);
    };
    const action = operation === "show" || operation === "api"
      ? createTag(DIRECTORY, VERSION, SHA, f.deps) : createRelease(DIRECTORY, undefined, f.deps);
    await assert.rejects(action, new RegExp(`${operation} offline`));
    if (operation === "create") assert.equal(f.calls.at(-1)[0], "remove");
  }
});

test("credentials and repository are required without executing commands", async () => {
  for (const env of [{ GH_TOKEN: "" }, { GITHUB_REPOSITORY: "" }, { GITHUB_REPOSITORY: "owner/repo/extra" }]) {
    const f = fixture({ env });
    await assert.rejects(createTag(DIRECTORY, VERSION, SHA, f.deps), /required|owner\/repository/);
    assert.deepEqual(f.calls, []);
  }
});

test("CLI strictly checks command and argument counts before side effects", async () => {
  for (const args of [[], ["unknown"], ["tag"], ["tag", DIRECTORY, VERSION], ["tag", DIRECTORY, VERSION, SHA, "extra"],
    ["release"], ["release", DIRECTORY, VERSION, "extra"]]) {
    const f = fixture();
    await assert.rejects(runCli(args, f.deps), /Usage:/);
    assert.deepEqual(f.calls, []);
  }
  const tag = fixture();
  assert.equal((await runCli(["tag", DIRECTORY, VERSION, SHA], tag.deps)).status, "created");
  const release = fixture({ exists: true });
  assert.equal((await runCli(["release", DIRECTORY], release.deps)).status, "skipped");
});
