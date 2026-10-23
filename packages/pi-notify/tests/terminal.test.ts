import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectTerminal,
  sendTerminalNotification,
  serializeNotification,
} from "../src/platforms/terminal.ts";

describe("terminal detection", () => {
  it("detects Ghostty and OSC 777", () => {
    const result = detectTerminal({ TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" });
    assert.deepEqual(result, { name: "ghostty", protocol: "osc777", signal: "TERM_PROGRAM=ghostty" });
  });

  it("detects WezTerm from its pane marker", () => {
    const result = detectTerminal({ WEZTERM_PANE: "3", TERM: "xterm-256color" });
    assert.deepEqual(result, { name: "wezterm", protocol: "osc777", signal: "WEZTERM_PANE" });
  });

  it("detects kitty and iTerm2", () => {
    assert.equal(detectTerminal({ KITTY_WINDOW_ID: "7" })?.protocol, "osc99");
    assert.equal(detectTerminal({ ITERM_SESSION_ID: "w0t0p0" })?.protocol, "osc9");
  });

  it("rejects unknown terminals", () => {
    assert.equal(detectTerminal({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }), null);
  });
});

describe("terminal notification serialization", () => {
  it("serializes OSC 777 and sanitizes delimiters and control characters", () => {
    const detection = detectTerminal({ TERM_PROGRAM: "ghostty" });
    assert.ok(detection);
    const sequence = serializeNotification(detection, "标题;", "正文\n\u001b恶意");
    assert.equal(sequence, "\u001b]777;notify;标题,;正文  恶意\u001b\\");
  });

  it("serializes kitty info notifications with urgency and expiry", () => {
    const detection = detectTerminal({ KITTY_WINDOW_ID: "1" });
    assert.ok(detection);
    const sequence = serializeNotification(detection, "Title", "Body");
    assert.equal(sequence.split("\u001b]99;").length, 3);
    assert.match(sequence, /p=title:e=1;/);
    assert.match(sequence, /p=body:e=1:u=0:w=5000;/);
  });

  it("maps kitty warning and error levels to distinct urgency and expiry", () => {
    const detection = detectTerminal({ KITTY_WINDOW_ID: "1" });
    assert.ok(detection);
    assert.match(serializeNotification(detection, "Title", "Body", "warning"), /u=1:w=8000;/);
    assert.match(serializeNotification(detection, "Title", "Body", "error"), /u=2:w=12000;/);
  });

  it("uses one message for OSC 9", () => {
    const detection = detectTerminal({ ITERM_SESSION_ID: "w0t0p0" });
    assert.ok(detection);
    assert.equal(serializeNotification(detection, "Title", "Body"), "\u001b]9;Title: Body\u001b\\");
  });
});

describe("terminal notification sending", () => {
  it("writes to a TTY and reports sent", async () => {
    let output = "";
    const result = await sendTerminalNotification(
      "Title",
      "Body",
      { isTTY: true, write(chunk, callback) { output += chunk; callback?.(); return true; } },
      { TERM_PROGRAM: "ghostty" },
    );
    assert.equal(result.status, "sent");
    assert.equal(result.level, "info");
    assert.equal(result.timeoutMs, undefined);
    assert.match(output, /\u001b\]777;notify;/);
  });

  it("reports the applied kitty warning expiry", async () => {
    const result = await sendTerminalNotification(
      "Title",
      "Body",
      { isTTY: true, write(_chunk, callback) { callback?.(); return true; } },
      { KITTY_WINDOW_ID: "1" },
      "warning",
    );
    assert.equal(result.status, "sent");
    assert.equal(result.level, "warning");
    assert.equal(result.timeoutMs, 8_000);
  });

  it("reports unsupported when stdout is not a TTY", async () => {
    const result = await sendTerminalNotification(
      "Title",
      "Body",
      { isTTY: false, write(_chunk, callback) { callback?.(); return true; } },
      { TERM_PROGRAM: "ghostty" },
    );
    assert.equal(result.status, "unsupported");
    assert.equal(result.level, "info");
    assert.equal(result.timeoutMs, undefined);
  });

  it("reports failed when the terminal stream rejects the write", async () => {
    const result = await sendTerminalNotification(
      "Title",
      "Body",
      { isTTY: true, write(_chunk, callback) { callback?.(new Error("write failed")); return false; } },
      { TERM_PROGRAM: "ghostty" },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.level, "info");
    assert.equal(result.timeoutMs, undefined);
    assert.equal(result.error, "write failed");
  });
});
