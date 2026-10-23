#!/usr/bin/env node
// 检查已跟踪的 Markdown 与 HTML 文档中的站内链接，以及指向 Markdown 标题的锚点。
// 外部链接（带协议头）与站点绝对路径不在检查范围内。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// Markdown 行内链接：目标可写成 <带空格的路径>，其后可跟 "标题"、'标题' 或 (标题)。
const MARKDOWN_LINK = /\]\(\s*(?:<([^>\n]*)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
// 引用式链接：[text][ref] 与 [ref]: target；只检查有定义的目标。
const REFERENCE_DEFINITION = /^\[([^\]]+)\]:\s*(?:<([^>\n]*)>|(\S+))/gm;
const REFERENCE_LINK = /\[([^\]]*)\]\[([^\]]*)\]/g;

function stripFencedCode(text) {
  const lines = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines.join("\n");
}

/** GitHub 风格的标题锚点：小写，去掉反引号与标点，空格转连字符，重复标题依次追加 -1、-2。 */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of stripFencedCode(markdown).split("\n")) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function linksIn(file, text) {
  const body = stripFencedCode(text);
  const links = [];
  if (file.endsWith(".md")) {
    const definitions = new Map();
    for (const match of body.matchAll(REFERENCE_DEFINITION)) {
      definitions.set(match[1].trim().toLowerCase(), match[2] ?? match[3]);
    }
    for (const match of body.matchAll(MARKDOWN_LINK)) links.push(match[1] ?? match[2]);
    for (const match of body.matchAll(REFERENCE_LINK)) {
      const key = (match[2] || match[1]).trim().toLowerCase();
      const target = definitions.get(key);
      if (target) links.push(target);
    }
  }
  for (const match of body.matchAll(/(?:href|src)="([^"]+)"/g)) links.push(match[1]);
  return links;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 返回 root 下给定文件中无法解析的站内链接，格式为 `文件: 说明 链接`。 */
export function findBrokenLinks(root, files) {
  const anchorCache = new Map();
  const anchorsOf = (path) => {
    if (!anchorCache.has(path)) anchorCache.set(path, headingAnchors(readFileSync(path, "utf8")));
    return anchorCache.get(path);
  };
  const broken = [];
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  for (const file of files) {
    for (const link of linksIn(file, readFileSync(join(root, file), "utf8"))) {
      if (EXTERNAL_LINK.test(link) || link.startsWith("/")) continue;
      const [rawPath, anchor = ""] = link.split("#", 2);
      const path = decode(rawPath.split("?")[0]);
      const target = path ? normalize(join(root, dirname(file), path)) : join(root, file);
      if (!target.startsWith(rootPrefix)) {
        broken.push(`${file}: escapes repository ${link}`);
      } else if (!existsSync(target)) {
        broken.push(`${file}: missing ${link}`);
      } else if (anchor && target.endsWith(".md") && !anchorsOf(target).has(decode(anchor).toLowerCase())) {
        broken.push(`${file}: missing anchor ${link}`);
      }
    }
  }
  return broken;
}

function trackedDocuments(root) {
  return execFileSync("git", ["ls-files", "*.md", "*.html"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = trackedDocuments(root);
  const broken = findBrokenLinks(root, files);
  if (broken.length > 0) {
    console.error(broken.join("\n"));
    console.error(`${broken.length} broken link(s) in ${files.length} tracked documents.`);
    process.exit(1);
  }
  console.log(`Checked links in ${files.length} tracked documents.`);
}
