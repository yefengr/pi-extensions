import { execFile } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const PACKAGES = Object.freeze([
  { directory: "pi-notify", name: "@yefengr/pi-notify" },
  { directory: "pi-monitor", name: "@yefengr/pi-monitor" },
  { directory: "pi-task-efficiency", name: "@yefengr/pi-task-efficiency" },
  { directory: "pi-subagents", name: "@yefengr/pi-subagents" },
].map(Object.freeze));
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 15_000;

export function validateVersion(version) {
  if (typeof version !== "string" || version.trim() !== version || !STABLE_VERSION.test(version)) {
    throw new Error(`Expected a stable exact X.Y.Z version: ${version}`);
  }
  return version;
}

export function validatePackage(metadata, directory) {
  const allowed = PACKAGES.find((entry) => entry.directory === directory);
  if (!allowed || metadata?.name !== allowed.name) {
    throw new Error(`Package identity is not allowlisted: ${directory}`);
  }
  if (metadata.private !== undefined && metadata.private !== false) {
    throw new Error(`Package must not be private: ${allowed.name}`);
  }
  return { ...allowed, version: validateVersion(metadata.version) };
}

export function selectPackages(eventName, ref, selectedPackage) {
  if (ref !== "refs/heads/main") throw new Error("Releases require refs/heads/main");
  if (eventName === "push") return PACKAGES;
  if (eventName !== "workflow_dispatch") throw new Error(`Unsupported event: ${eventName}`);
  const selected = PACKAGES.find((entry) => entry.name === selectedPackage);
  if (!selected) throw new Error("Manual package is not allowlisted");
  return [selected];
}

export function packageMatrix() {
  // GitHub Actions 的 matrix 只暴露目录名；包清单仍以 PACKAGES 为唯一真源。
  return { include: PACKAGES.map(({ directory }) => ({ directory })) };
}

export async function readPreviousVersion(before, directory, run = exec) {
  const file = `packages/${directory}/package.json`;
  // 先确认提交可读；只有成功的 ls-tree 空结果才代表旧文件不存在。
  await run("git", ["cat-file", "-e", `${before}^{commit}`]);
  const tree = await run("git", ["ls-tree", "-z", "--name-only", before, "--", file]);
  if (tree.stdout === "") return null;
  if (tree.stdout !== `${file}\0`) throw new Error(`Unexpected git tree entry: ${file}`);
  const previous = await run("git", ["show", `${before}:${file}`]);
  return validateVersion(JSON.parse(previous.stdout).version);
}

export async function isPublished(candidate, { fetchImpl = fetch, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  // 包名与版本均已校验；仅查询精确版本，不以 dist-tag 推断是否存在。
  const url = `${REGISTRY}/${encodeURIComponent(candidate.name)}/${candidate.version}`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  if (response.status !== 200) throw new Error(`Registry returned HTTP ${response.status} for ${candidate.name}`);
  const metadata = await response.json();
  if (metadata?.name !== candidate.name || metadata?.version !== candidate.version) {
    throw new Error(`Registry identity mismatch for ${candidate.name}@${candidate.version}`);
  }
  return true;
}

export async function createPlan({ eventName, ref, before, selectedPackage }, {
  readPackage = async (directory) => JSON.parse(await readFile(`packages/${directory}/package.json`, "utf8")),
  previousVersion = readPreviousVersion,
  published = isPublished,
} = {}) {
  const selected = selectPackages(eventName, ref, selectedPackage);
  if (eventName === "push" && (typeof before !== "string" || before.length !== 40 || !/^[a-f0-9]{40}$/.test(before))) {
    throw new Error("Push before must be a full commit SHA");
  }
  const firstPush = eventName === "push" && /^0{40}$/.test(before);
  const include = [];
  const summary = [];
  for (const entry of selected) {
    const candidate = validatePackage(await readPackage(entry.directory), entry.directory);
    if (eventName === "push" && !firstPush) {
      const oldVersion = await previousVersion(before, entry.directory);
      if (oldVersion === candidate.version) {
        summary.push(`${candidate.name}@${candidate.version}: skipped (version unchanged).`);
        continue;
      }
    }
    if (await published(candidate)) {
      summary.push(`${candidate.name}@${candidate.version}: skipped (already public on npm).`);
      continue;
    }
    include.push(candidate);
    summary.push(`${candidate.name}@${candidate.version}: candidate for staging (not publicly released).`);
  }
  return { hasPackages: include.length > 0, matrix: { include }, summary };
}

export function validateNpmVersion(version) {
  validateVersion(version);
  const [major, minor] = version.split(".").map(Number);
  if (major < 11 || (major === 11 && minor < 15)) {
    throw new Error(`npm >=11.15.0 is required for staged publishing; found ${version}`);
  }
}

export async function validateArtifact(directory, expected, { run = exec, list = readdir } = {}) {
  const candidate = validatePackage(expected, expected.directory);
  const entries = await list(directory, { withFileTypes: true });
  const tarballs = entries.filter((entry) => entry.name.endsWith(".tgz"));
  if (tarballs.length !== 1 || !tarballs[0].isFile()) {
    throw new Error("Artifact directory must contain exactly one regular .tgz file");
  }
  const tarball = path.resolve(directory, tarballs[0].name);
  const result = await run("tar", ["-xOf", tarball, "package/package.json"]);
  const metadata = validatePackage(JSON.parse(result.stdout), candidate.directory);
  if (metadata.version !== candidate.version) throw new Error("Artifact version does not match release plan");
  return tarball;
}

async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  if (/[\r\n]/.test(value)) throw new Error("Workflow output must be a single line");
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main(command) {
  if (command === "plan") {
    const plan = await createPlan({
      eventName: process.env.RELEASE_EVENT,
      ref: process.env.RELEASE_REF,
      before: process.env.RELEASE_BEFORE,
      selectedPackage: process.env.RELEASE_PACKAGE,
    });
    await output("has-packages", String(plan.hasPackages));
    await output("matrix", JSON.stringify(plan.matrix));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release plan\n\n${plan.summary.map((line) => `- ${line}`).join("\n")}\n`);
    }
    return;
  }
  if (command === "matrix") {
    process.stdout.write(`${JSON.stringify(packageMatrix())}\n`);
    return;
  }
  if (command === "validate-npm") {
    validateNpmVersion((await exec("npm", ["--version"])).stdout.trim());
    return;
  }
  if (command === "validate-artifact") {
    validateNpmVersion((await exec("npm", ["--version"])).stdout.trim());
    const tarball = await validateArtifact(process.env.ARTIFACT_DIRECTORY, {
      directory: process.env.PACKAGE_DIRECTORY,
      name: process.env.PACKAGE_NAME,
      version: process.env.PACKAGE_VERSION,
    });
    await output("tarball", tarball);
    return;
  }
  throw new Error("Usage: node scripts/release.mjs <plan|matrix|validate-npm|validate-artifact>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
