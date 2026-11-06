import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM 解析保留 SDK 的 import 条件；不依赖根目录提升、全局 pi 或机器路径。
export { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
export const piPackage = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = path.resolve(path.dirname(piPackage), "..");
const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
export const piCli = path.resolve(packageRoot, metadata.bin.pi);
