import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

test("发布元数据仅声明宿主 SDK peers，源码模块不超过 600 行", async () => {
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(metadata.name, "@yefengr/pi-worktree");
  assert.match(metadata.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(metadata.pi.extensions, ["./index.ts"]);
  assert.equal(metadata.dependencies, undefined);
  assert.deepEqual(metadata.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
  for (const file of await readdir(path.join(root, "src"))) {
    const content = await readFile(path.join(root, "src", file), "utf8");
    assert.ok(content.trimEnd().split("\n").length <= 600, file);
    assert.doesNotMatch(content, /\/Users\/|agent-tools\/|process\.chdir/);
  }
});

test("真实 tarball 在新路径可加载并实际执行打包创建器，保留持久所有权格式", async () => {
  // 放在 workspace 内使解包后的 SDK 能由本包声明的开发依赖解析，不复制 SDK。
  const temporaryRoot = path.resolve(root, "../../.pi/tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const sandbox = await mkdtemp(path.join(temporaryRoot, "worktree-package-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", sandbox], root));
    const files = new Set<string>(packed.files.map((entry: { path: string }) => entry.path));
    for (const file of ["index.ts", "src/extension.ts", "src/worktree-remove.ts", "src/worktree-repository.ts",
      "scripts/create-worktree.sh", "README.md", "LICENSE", "CHANGELOG.md"]) {
      assert.ok(files.has(file), file);
    }
    assert.equal([...files].some((file) => /(^|\/)(tests|node_modules|\.pi)(\/|$)|tsconfig|biome/.test(file)), false);
    const packedCreator = packed.files.find((entry: { path: string }) => entry.path === "scripts/create-worktree.sh");
    assert.ok(packedCreator && (packedCreator.mode & 0o111) !== 0, "发布创建器必须保留可执行位");
    run("tar", ["-xzf", path.join(sandbox, packed.filename), "-C", sandbox], root);
    assert.notEqual((await stat(path.join(sandbox, "package/scripts/create-worktree.sh"))).mode & 0o111, 0);
    const repo = path.join(sandbox, "repo");
    const agentDir = path.join(sandbox, "agent");
    await mkdir(repo);
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "fixture"],
      ["config", "user.email", "fixture@example.invalid"]]) run("git", ["-C", repo, ...args], root);
    await writeFile(path.join(repo, "README.md"), "isolated synthetic fixture\n");
    run("git", ["-C", repo, "add", "README.md"], root);
    run("git", ["-C", repo, "commit", "-qm", "fixture"], root);
    const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
    const loaded = await discoverAndLoadExtensions([path.join(sandbox, "package", "index.ts")], repo, agentDir);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    assert.deepEqual([...extension.commands.keys()].sort(), [
      "worktree:create", "worktree:list", "worktree:migrate", "worktree:remove", "worktree:switch",
    ]);
    assert.deepEqual([...extension.tools.keys()].sort(), ["worktree_create", "worktree_list", "worktree_remove"]);
    assert.ok(extension.shortcuts.has("ctrl+alt+w"));
    const create = extension.tools.get("worktree_create")!.definition;
    const ctx = { cwd: await realpath(repo), sessionManager: { getSessionFile: () => undefined } };
    const result = await create.execute("packed-create", {
      name: "packed", mode: "new-branch", baseRef: "main", branch: "feat/packed",
    }, undefined, undefined, ctx as never);
    const details = result.details as { worktreePath: string; migrationStatus: string };
    assert.equal(details.migrationStatus, "unavailable");
    const gitDir = run("git", ["-C", details.worktreePath, "rev-parse", "--absolute-git-dir"], root).trim();
    const marker = JSON.parse(await readFile(path.join(gitDir, "pi-worktree-manager.json"), "utf8"));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(new Date(marker.createdAt).toISOString(), marker.createdAt);
    const remove = extension.tools.get("worktree_remove")!.definition;
    const removed = await remove.execute("packed-remove", {
      worktreePath: details.worktreePath, confirmed: true,
    }, undefined, undefined, ctx as never);
    assert.equal((removed.details as { branchStatus: string }).branchStatus, "deleted");
    assert.equal(run("git", ["-C", repo, "branch", "--list", "feat/packed"], root).trim(), "");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(sandbox, { recursive: true, force: true });
  }
});
