import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { NOTIFICATION_TYPE, RESULT_TYPE } from "./constants.ts";
import { receiptOf, type Entry } from "./state.ts";

const CHUNK_BYTES = 65_536;
const MAX_LINE_LENGTH = 2_097_152;

/** message_end 早于 Pi 落盘；只接受文件中完整且仍属于活动分支的回执。 */
export function persistedReceiptIds(file: string | undefined, branch: readonly Entry[], wanted?: ReadonlySet<string>): Set<string> {
  const candidates = new Set(branch.filter((entry) => {
    const receipt = receiptOf(entry);
    return entry.id && receipt && (!wanted || receipt.deliveries.some((item) => item.batchIds.some((id) => wanted.has(id))));
  }).map((entry) => entry.id!));
  const confirmed = new Set<string>();
  if (!file || !candidates.size) return confirmed;
  const fd = openSync(file, "r");
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let dropping = false;
  const accept = (line: string) => {
    if (line.length > MAX_LINE_LENGTH || (!line.includes(RESULT_TYPE) && !line.includes(NOTIFICATION_TYPE))) return;
    try {
      const entry = JSON.parse(line) as Entry;
      if (entry.id && candidates.has(entry.id) && receiptOf(entry)) confirmed.add(entry.id);
    } catch { /* 不把不完整/损坏行当作投递确认。 */ }
  };
  try {
    while (true) {
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (length <= 0) break;
      let text = decoder.write(chunk.subarray(0, length));
      if (dropping) {
        const newline = text.indexOf("\n");
        if (newline < 0) continue;
        text = text.slice(newline + 1); dropping = false;
      }
      carry += text;
      let end = carry.indexOf("\n");
      while (end >= 0) {
        accept(carry.slice(0, end)); carry = carry.slice(end + 1);
        end = carry.indexOf("\n");
      }
      if (carry.length > MAX_LINE_LENGTH) { carry = ""; dropping = true; }
      if (confirmed.size === candidates.size) break;
    }
    // 原生 JSONL 每条以 LF 结束；尾部无 LF 的行不能证明 append 已完成。
    return confirmed;
  } finally { closeSync(fd); }
}
