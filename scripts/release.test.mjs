import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  PACKAGES, createPlan, isPublished, packageMatrix, readPreviousVersion, selectPackages,
  validateArtifact, validateNpmVersion, validatePackage, validateVersion,
} from "./release.mjs";

const BEFORE = "a".repeat(40);
const push = { eventName: "push", ref: "refs/heads/main", before: BEFORE };

test("package matrix is derived from the shared package list", () => {
  assert.deepEqual(packageMatrix(), { include: PACKAGES.map(({ directory }) => ({ directory })) });
});

const candidate = { ...PACKAGES[0], version: "1.2.3" };
const metadata = (directory) => ({ name: PACKAGES.find((entry) => entry.directory === directory).name, version: "1.2.3" });
const dependencies = (overrides = {}) => ({
  readPackage: async (directory) => metadata(directory),
  previousVersion: async () => "1.2.3",
  published: async () => false,
  ...overrides,
});

test("unchanged versions skip registry even when other metadata changes", async () => {
  const plan = await createPlan(push, dependencies({
    readPackage: async (directory) => ({ ...metadata(directory), dependencies: { example: "2.0.0" } }),
    published: async () => assert.fail("unchanged version must not query registry"),
  }));
  assert.equal(plan.hasPackages, false);
  assert.deepEqual(plan.matrix, { include: [] });
  assert.equal(plan.summary.length, 4);
  assert.ok(plan.summary.every((line) => line.includes("version unchanged")));
});

test("one version change produces only that package", async () => {
  const plan = await createPlan(push, dependencies({
    previousVersion: async (_, directory) => directory === candidate.directory ? "1.2.2" : "1.2.3",
  }));
  assert.deepEqual(plan.matrix.include, [candidate]);
  assert.equal(plan.hasPackages, true);
});

test("multiple version changes produce independent candidates", async () => {
  const plan = await createPlan(push, dependencies({ previousVersion: async () => "1.2.2" }));
  assert.deepEqual(plan.matrix.include.map((entry) => entry.name), PACKAGES.map((entry) => entry.name));
});

test("manual selection bypasses before comparison but still queries registry", async () => {
  let queries = 0;
  const plan = await createPlan({ eventName: "workflow_dispatch", ref: push.ref, selectedPackage: candidate.name }, dependencies({
    previousVersion: async () => assert.fail("manual must not inspect before"),
    published: async () => { queries++; return true; },
  }));
  assert.equal(queries, 1);
  assert.equal(plan.hasPackages, false);
  assert.match(plan.summary[0], /already public/);
});

test("manual selection is allowlisted for all four packages", () => {
  for (const entry of PACKAGES) {
    assert.deepEqual(selectPackages("workflow_dispatch", push.ref, entry.name), [entry]);
  }
  for (const invalid of [undefined, "", "@other/package", "$(touch anything)"]) {
    assert.throws(() => selectPackages("workflow_dispatch", push.ref, invalid), /allowlisted/);
  }
});

test("only main and supported events can release", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    assert.throws(() => selectPackages(event, "refs/heads/feature", candidate.name), /main/);
    assert.throws(() => selectPackages(event, "refs/tags/main", candidate.name), /main/);
  }
  assert.throws(() => selectPackages("pull_request", push.ref), /Unsupported event/);
});

test("private and malformed identity are rejected", () => {
  for (const privateValue of [true, "false", null, 0]) {
    assert.throws(() => validatePackage({ ...candidate, private: privateValue }, candidate.directory), /private/);
  }
  assert.deepEqual(validatePackage({ ...candidate, private: false }, candidate.directory), candidate);
  assert.throws(() => validatePackage({ ...candidate, name: "@other/package" }, candidate.directory), /identity/);
  assert.throws(() => validatePackage(candidate, "../pi-notify"), /identity/);
  assert.throws(() => validatePackage(null, candidate.directory), /identity/);
});

test("versions must be stable exact canonical X.Y.Z", () => {
  for (const version of [undefined, null, 123, "1.2", "v1.2.3", "1.2.3-beta.1", "1.2.3+build", "01.2.3", "^1.2.3", "1.2.3\n"]) {
    assert.throws(() => validateVersion(version), /X.Y.Z/);
  }
  for (const version of ["0.0.0", "1.2.3", "11.20.100"]) assert.equal(validateVersion(version), version);
});

test("invalid current metadata fails the plan before registry", async () => {
  for (const change of [{ name: "wrong" }, { private: true }, { version: "1.0.0-beta" }]) {
    await assert.rejects(createPlan(push, dependencies({
      readPackage: async (directory) => ({ ...metadata(directory), ...change }),
      published: async () => assert.fail("invalid metadata must not query registry"),
    })));
  }
});

test("missing or malformed before SHA fails closed", async () => {
  for (const before of [undefined, "", "abc", "HEAD", "-bad", "g".repeat(40), `${"0".repeat(40)}\n`]) {
    await assert.rejects(createPlan({ ...push, before }, dependencies()), /full commit SHA/);
  }
});

test("first push queries every package without reading previous files", async () => {
  const plan = await createPlan({ ...push, before: "0".repeat(40) }, dependencies({
    previousVersion: async () => assert.fail("zero before must not read git"),
  }));
  assert.equal(plan.matrix.include.length, 4);
});

test("new package files are candidates", async () => {
  const plan = await createPlan(push, dependencies({ previousVersion: async () => null }));
  assert.equal(plan.matrix.include.length, 4);
});

test("unreadable nonzero before propagates failure", async () => {
  await assert.rejects(createPlan(push, dependencies({ previousVersion: async () => { throw new Error("missing commit"); } })), /missing commit/);
});

test("git reader uses exact execFile arguments and reads existing version", async () => {
  const calls = [];
  const file = `packages/${candidate.directory}/package.json`;
  const version = await readPreviousVersion(BEFORE, candidate.directory, async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "ls-tree") return { stdout: `${file}\0` };
    if (args[0] === "show") return { stdout: JSON.stringify({ version: "1.0.0" }) };
    return { stdout: "" };
  });
  assert.equal(version, "1.0.0");
  assert.deepEqual(calls, [
    ["git", ["cat-file", "-e", `${BEFORE}^{commit}`]],
    ["git", ["ls-tree", "-z", "--name-only", BEFORE, "--", file]],
    ["git", ["show", `${BEFORE}:${file}`]],
  ]);
});

test("git reader distinguishes absent files from commit, tree, and blob errors", async () => {
  assert.equal(await readPreviousVersion(BEFORE, candidate.directory, async () => ({ stdout: "" })), null);
  for (const failedCommand of ["cat-file", "ls-tree", "show"]) {
    await assert.rejects(readPreviousVersion(BEFORE, candidate.directory, async (_, args) => {
      if (args[0] === failedCommand) throw new Error(`${failedCommand} failed`);
      return { stdout: args[0] === "ls-tree" ? `packages/${candidate.directory}/package.json\0` : "" };
    }), new RegExp(`${failedCommand} failed`));
  }
  await assert.rejects(readPreviousVersion(BEFORE, candidate.directory, async (_, args) => ({
    stdout: args[0] === "ls-tree" ? "unexpected\0" : "",
  })), /Unexpected git tree/);
});

test("HTTP 200 requires exact registry identity and uses bounded request", async () => {
  assert.equal(await isPublished(candidate, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://registry.npmjs.org/%40yefengr%2Fpi-notify/1.2.3");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(candidate);
  } }), true);
});

test("HTTP 404 is the only absence response", async () => {
  assert.equal(await isPublished(candidate, { fetchImpl: async () => new Response(null, { status: 404 }) }), false);
});

test("HTTP 5xx, rate limits, authentication errors and redirects fail closed", async () => {
  for (const status of [201, 301, 401, 403, 429, 500, 503]) {
    await assert.rejects(isPublished(candidate, { fetchImpl: async () => new Response(null, { status }) }), new RegExp(`HTTP ${status}`));
  }
});

test("network errors propagate", async () => {
  await assert.rejects(isPublished(candidate, { fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
});

test("registry timeout aborts the request", async () => {
  await assert.rejects(isPublished(candidate, {
    timeoutMs: 5,
    fetchImpl: async (_, { signal }) => { await delay(1_000, undefined, { signal }); return Response.json(candidate); },
  }), { name: "AbortError" });
});

test("malformed HTTP 200 JSON and mismatched identity fail closed", async () => {
  await assert.rejects(isPublished(candidate, { fetchImpl: async () => new Response("invalid json") }), SyntaxError);
  for (const body of [null, {}, [], { ...candidate, name: "wrong" }, { ...candidate, version: "1.2.4" }]) {
    await assert.rejects(isPublished(candidate, { fetchImpl: async () => Response.json(body) }), /identity mismatch/);
  }
});

test("registry errors fail the whole plan, not a partial release matrix", async () => {
  let queries = 0;
  await assert.rejects(createPlan(push, dependencies({
    previousVersion: async () => "1.0.0",
    published: async () => { if (++queries === 2) throw new Error("registry failed"); return false; },
  })), /registry failed/);
});

test("npm 11.15.0 is the minimum stable staged publishing version", () => {
  for (const version of ["11.15.0", "11.19.1", "12.0.0"]) validateNpmVersion(version);
  for (const version of ["10.99.0", "11.14.99", "11.15.0-beta", "invalid"]) {
    assert.throws(() => validateNpmVersion(version));
  }
});

const fileEntry = (name, isFile = true) => ({ name, isFile: () => isFile });
const artifactDeps = (entries, contents = candidate) => ({
  list: async () => entries,
  run: async () => ({ stdout: JSON.stringify(contents) }),
});

test("artifact validation requires exactly one regular tarball", async () => {
  for (const entries of [[], [fileEntry("a.tgz"), fileEntry("b.tgz")], [fileEntry("link.tgz", false)]]) {
    await assert.rejects(validateArtifact("/artifact", candidate, artifactDeps(entries)), /exactly one regular/);
  }
});

test("artifact metadata is read without extraction using exact tar arguments", async () => {
  const tarball = await validateArtifact("/artifact", candidate, {
    list: async () => [fileEntry("package.tgz"), fileEntry("notes.txt")],
    run: async (command, args) => {
      assert.equal(command, "tar");
      assert.deepEqual(args, ["-xOf", "/artifact/package.tgz", "package/package.json"]);
      return { stdout: JSON.stringify(candidate) };
    },
  });
  assert.equal(tarball, "/artifact/package.tgz");
});

test("artifact identity, private flag, version and JSON must match the plan", async () => {
  for (const contents of [{ ...candidate, name: "wrong" }, { ...candidate, private: true }, { ...candidate, version: "1.2.4" }, { ...candidate, version: "1.2.3-beta" }]) {
    await assert.rejects(validateArtifact("/artifact", candidate, artifactDeps([fileEntry("a.tgz")], contents)));
  }
  await assert.rejects(validateArtifact("/artifact", candidate, {
    list: async () => [fileEntry("a.tgz")], run: async () => ({ stdout: "invalid" }),
  }), SyntaxError);
  await assert.rejects(validateArtifact("/artifact", candidate, {
    list: async () => [fileEntry("a.tgz")], run: async () => { throw new Error("corrupt tar"); },
  }), /corrupt tar/);
});

test("real filesystem artifact listing is isolated and cleaned up", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-release-test-"));
  try {
    await writeFile(path.join(directory, "only.tgz"), "fixture");
    assert.equal(await validateArtifact(directory, candidate, {
      run: async () => ({ stdout: JSON.stringify(candidate) }),
    }), path.join(directory, "only.tgz"));
    await writeFile(path.join(directory, "extra.tgz"), "fixture");
    await assert.rejects(validateArtifact(directory, candidate), /exactly one regular/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
