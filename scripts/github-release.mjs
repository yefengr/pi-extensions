import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PACKAGES, isPublished, validatePackage, validateVersion } from "./release.mjs";

const exec = promisify(execFile);
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const USAGE = "Usage: node scripts/github-release.mjs tag <directory> <version> <commit> | release <directory> [version]";

function dependencies(overrides) {
  return {
    run: exec,
    readPackage: async (directory) => JSON.parse(await readFile(`packages/${directory}/package.json`, "utf8")),
    fetchImpl: fetch,
    append: appendFile,
    write: writeFile,
    makeTemp: mkdtemp,
    remove: rm,
    env: process.env,
    log: console.log,
    ...overrides,
  };
}

function requireDirectory(directory) {
  const entry = PACKAGES.find((item) => item.directory === directory);
  if (!entry) throw new Error(`Package directory is not allowlisted: ${directory}`);
  return entry;
}

function requireCommit(commit) {
  if (typeof commit !== "string" || commit.length !== 40 || !COMMIT_SHA.test(commit)) {
    throw new Error("Commit must be a full 40-character SHA");
  }
  return commit;
}

function requireEnvironment(env) {
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN is required");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
}

async function summary(message, deps) {
  deps.log(message);
  if (deps.env.GITHUB_STEP_SUMMARY) {
    await deps.append(deps.env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
  }
}

async function api(endpoint, deps, fields = []) {
  const { stdout } = await deps.run("gh", ["api", endpoint, ...fields]);
  return JSON.parse(stdout);
}

async function remoteTagCommit(tag, deps) {
  const base = `repos/${deps.env.GITHUB_REPOSITORY}/git`;
  // matching-refs 在不存在时成功返回空数组，避免把鉴权或网络失败当作标签缺失。
  const refs = await api(`${base}/matching-refs/tags/${tag}`, deps);
  if (!Array.isArray(refs)) throw new Error("Unexpected GitHub tag refs response");
  const ref = refs.find((item) => item.ref === `refs/tags/${tag}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; depth < 10; depth++) {
    requireCommit(object?.sha);
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag") throw new Error(`Tag ${tag} does not point to a commit`);
    object = (await api(`${base}/tags/${object.sha}`, deps)).object;
  }
  throw new Error(`Tag ${tag} has too many nested annotated tags`);
}

export async function createTag(directory, version, commit, overrides = {}) {
  const entry = requireDirectory(directory);
  validateVersion(version);
  requireCommit(commit);
  const deps = dependencies(overrides);
  requireEnvironment(deps.env);
  const { stdout } = await deps.run("git", ["show", `${commit}:packages/${directory}/package.json`]);
  const metadata = validatePackage(JSON.parse(stdout), directory);
  if (metadata.version !== version) throw new Error(`Commit package version ${metadata.version} does not match ${version}`);
  const tag = `${directory}-v${version}`;
  const existing = await remoteTagCommit(tag, deps);
  if (existing) {
    if (existing !== commit) throw new Error(`Tag ${tag} already points to another commit: ${existing}`);
    await summary(`${tag} already exists at ${commit}; skipped.`, deps);
    return { status: "skipped", tag };
  }
  const base = `repos/${deps.env.GITHUB_REPOSITORY}/git`;
  const object = await api(`${base}/tags`, deps, [
    "--method", "POST", "-f", `tag=${tag}`, "-f", `message=${entry.name} ${version}`,
    "-f", `object=${commit}`, "-f", "type=commit",
  ]);
  requireCommit(object.sha);
  await api(`${base}/refs`, deps, ["--method", "POST", "-f", `ref=refs/tags/${tag}`, "-f", `sha=${object.sha}`]);
  await summary(`Created annotated tag ${tag} at ${commit}; GitHub Release follows npm approval.`, deps);
  return { status: "created", tag };
}

async function localTagCommit(tag, deps) {
  const { stdout } = await deps.run("git", ["for-each-ref", "--format=%(refname)", `refs/tags/${tag}`]);
  // 标签缺失是待补打状态，不是命令错误；只有 rev-parse 失败才向上传播。
  if (!stdout.trim().split("\n").includes(`refs/tags/${tag}`)) return null;
  const result = await deps.run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  return requireCommit(result.stdout.trim());
}

async function releaseExists(tag, deps) {
  try {
    await deps.run("gh", ["release", "view", tag, "--repo", deps.env.GITHUB_REPOSITORY, "--json", "tagName"]);
    return true;
  } catch (error) {
    // gh 的明确不存在消息才允许继续；网络、限流与鉴权等命令失败一律向上传播。
    if (error.code !== 1 || error.stderr?.trim() !== "release not found") throw error;
    return false;
  }
}

async function previousPublishedTag(candidate, tag, commit, deps) {
  const ancestry = await deps.run("git", ["rev-list", "--parents", "-n", "1", tag]);
  const [actual, parent] = ancestry.stdout.trim().split(/\s+/);
  if (requireCommit(actual) !== commit) throw new Error(`Tag ${tag} changed while preparing release`);
  // 根提交没有前序历史，不能用失败的 tag^ 查询掩盖真正的 git 错误。
  if (!parent) return null;
  requireCommit(parent);
  const tags = await deps.run("git", [
    "tag", "--merged", parent, "--list", `${candidate.directory}-v*`, "--sort=-version:refname",
  ]);
  for (const previous of tags.stdout.trim().split("\n").filter(Boolean)) {
    const prefix = `${candidate.directory}-v`;
    if (!previous.startsWith(prefix)) throw new Error(`Unexpected tag: ${previous}`);
    const version = previous.slice(prefix.length);
    try { validateVersion(version); } catch { continue; }
    if (await isPublished({ ...candidate, version }, { fetchImpl: deps.fetchImpl })) return previous;
  }
  return null;
}

export async function generateNotes(candidate, tag, commit, overrides = {}) {
  const deps = dependencies(overrides);
  const previous = await previousPublishedTag(candidate, tag, commit, deps);
  const { stdout } = await deps.run("git", [
    "log", "--no-merges", "--format=- %s", previous ? `${previous}..${tag}` : tag, "--", `packages/${candidate.directory}`,
  ]);
  const lines = [
    `npm：[\`${candidate.name}@${candidate.version}\`](https://www.npmjs.com/package/${candidate.name}/v/${candidate.version})`, "",
  ];
  if (deps.env.RUN_URL) lines.push(`发布记录：[查看工作流](${deps.env.RUN_URL})`, "");
  lines.push("## 变更", "", stdout.trim() || `- 自 ${previous ?? "首个版本"} 以来没有涉及此包的提交。`, "");
  return lines.join("\n");
}

export async function createRelease(directory, version, overrides = {}) {
  requireDirectory(directory);
  if (version !== undefined) validateVersion(version);
  const deps = dependencies(overrides);
  requireEnvironment(deps.env);
  const current = validatePackage(await deps.readPackage(directory), directory);
  const candidate = { ...current, version: version ?? current.version };
  const tag = `${directory}-v${candidate.version}`;
  // 先查 npm：待审或未提交的版本没有标签是正常状态，不能让定时任务长期失败。
  if (!await isPublished(candidate, { fetchImpl: deps.fetchImpl })) {
    await summary(`${candidate.name}@${candidate.version} is not public on npm yet; skipped.`, deps);
    return { status: "pending", tag };
  }
  const commit = await localTagCommit(tag, deps);
  if (!commit) {
    // 本地缺失但远端存在说明 checkout 视图过期；这是配置故障，不能静默跳过。
    if (await remoteTagCommit(tag, deps)) {
      throw new Error(`Tag ${tag} exists on the remote but not in the local checkout; fetch tags and rerun.`);
    }
    const message = `${candidate.name}@${candidate.version} is public but tag ${tag} is missing; create the annotated tag at the staged commit and rerun. 请手工补打标签。`;
    // 定时任务在存量版本补打标签前不应每 30 分钟失败；手动补建时直接失败并给出操作指引。
    if (deps.env.GITHUB_EVENT_NAME === "schedule") {
      deps.log(`::warning::${message}`);
      await summary(`${message} Skipped for this scheduled run.`, deps);
      return { status: "missing-tag", tag };
    }
    throw new Error(message);
  }
  if (await releaseExists(tag, deps)) {
    await summary(`GitHub Release ${tag} already exists; skipped.`, deps);
    return { status: "skipped", tag };
  }
  const notes = await generateNotes(candidate, tag, commit, deps);
  const temporary = await deps.makeTemp(path.join(deps.env.RUNNER_TEMP || os.tmpdir(), "pi-github-release-"));
  try {
    const notesFile = path.join(temporary, `${tag}.md`);
    await deps.write(notesFile, notes, "utf8");
    await deps.run("gh", [
      "release", "create", tag, "--repo", deps.env.GITHUB_REPOSITORY, "--verify-tag",
      "--title", `${directory} ${candidate.version}`, "--notes-file", notesFile,
      candidate.version === current.version ? "--latest" : "--latest=false",
    ]);
  } finally {
    await deps.remove(temporary, { recursive: true, force: true });
  }
  await summary(`Created GitHub Release ${tag} at ${commit}.`, deps);
  return { status: "created", tag };
}

export async function runCli(args, overrides = {}) {
  const [command, directory, version, commit] = args;
  if (command === "tag" && args.length === 4) return createTag(directory, version, commit, overrides);
  if (command === "release" && (args.length === 2 || args.length === 3)) return createRelease(directory, version, overrides);
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
