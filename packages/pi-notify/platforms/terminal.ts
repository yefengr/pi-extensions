import type {
  NotificationLevel,
  NotifyResult,
  TerminalDetection,
  TerminalName,
  TerminalProtocol,
} from "../types.js";

export const NOTIFICATION_TIMEOUT_MS: Readonly<Record<NotificationLevel, number>> = {
  info: 5_000,
  warning: 8_000,
  error: 12_000,
};

const OSC = "\u001b]";
const ST = "\u001b\\";
const MAX_TEXT_BYTES = 4096;
const KITTY_URGENCY: Readonly<Record<NotificationLevel, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};
let kittyNotificationId = 0;

export interface TerminalOutput {
  readonly isTTY?: boolean;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
}

/** Detect only terminals with a verified notification protocol. */
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalDetection | null {
  const term = (env.TERM ?? "").trim().toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").trim().toLowerCase();

  if (env.KITTY_WINDOW_ID || term === "xterm-kitty") {
    return { name: "kitty", protocol: "osc99", signal: env.KITTY_WINDOW_ID ? "KITTY_WINDOW_ID" : "TERM=xterm-kitty" };
  }
  if (env.WEZTERM_PANE || program === "wezterm") {
    return { name: "wezterm", protocol: "osc777", signal: env.WEZTERM_PANE ? "WEZTERM_PANE" : "TERM_PROGRAM=WezTerm" };
  }
  if (env.GHOSTTY_RESOURCES_DIR || program === "ghostty" || term === "xterm-ghostty") {
    return {
      name: "ghostty",
      protocol: "osc777",
      signal: env.GHOSTTY_RESOURCES_DIR
        ? "GHOSTTY_RESOURCES_DIR"
        : program === "ghostty"
          ? "TERM_PROGRAM=ghostty"
          : "TERM=xterm-ghostty",
    };
  }
  if (env.ITERM_SESSION_ID || program === "iterm.app" || program === "iterm2") {
    return {
      name: "iterm2",
      protocol: "osc9",
      signal: env.ITERM_SESSION_ID ? "ITERM_SESSION_ID" : "TERM_PROGRAM=iTerm.app",
    };
  }
  return null;
}

export function serializeNotification(
  detection: TerminalDetection,
  title: string,
  message: string,
  level: NotificationLevel = "info",
): string {
  const safeTitle = sanitizeText(title, detection.protocol === "osc777");
  const safeMessage = sanitizeText(message, detection.protocol === "osc777");

  switch (detection.protocol) {
    case "osc777":
      return `${OSC}777;notify;${safeTitle};${safeMessage}${ST}`;
    case "osc99":
      return serializeKittyNotification(safeTitle, safeMessage, level);
    case "osc9":
      return `${OSC}9;${safeTitle}: ${safeMessage}${ST}`;
  }
}

export async function sendTerminalNotification(
  title: string,
  message: string,
  output: TerminalOutput = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
  level: NotificationLevel = "info",
): Promise<NotifyResult> {
  const detection = detectTerminal(env);
  if (!detection) {
    return { status: "unsupported", level, error: "当前终端不在通知协议白名单中" };
  }
  if (output.isTTY !== true) {
    return {
      status: "unsupported",
      level,
      terminal: detection.name,
      protocol: detection.protocol,
      error: "标准输出不是 TTY",
    };
  }

  const timeoutMs = detection.protocol === "osc99"
    ? NOTIFICATION_TIMEOUT_MS[level]
    : undefined;

  try {
    await writeOutput(output, serializeNotification(detection, title, message, level));
    return { status: "sent", level, timeoutMs, terminal: detection.name, protocol: detection.protocol };
  } catch (error) {
    return {
      status: "failed",
      level,
      timeoutMs,
      terminal: detection.name,
      protocol: detection.protocol,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isTerminalSupported(
  output: TerminalOutput = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return output.isTTY === true && detectTerminal(env) !== null;
}

function serializeKittyNotification(
  title: string,
  message: string,
  level: NotificationLevel,
): string {
  const id = `${Date.now().toString(36)}-${(++kittyNotificationId).toString(36)}`;
  const encodedTitle = Buffer.from(title, "utf8").toString("base64");
  const encodedMessage = Buffer.from(message, "utf8").toString("base64");
  const titlePart = `${OSC}99;i=${id}:d=0:p=title:e=1;${encodedTitle}${ST}`;
  const bodyPart = `${OSC}99;i=${id}:d=1:p=body:e=1:u=${KITTY_URGENCY[level]}:w=${NOTIFICATION_TIMEOUT_MS[level]};${encodedMessage}${ST}`;
  return titlePart + bodyPart;
}

function sanitizeText(value: string, replaceSemicolons: boolean): string {
  let result = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (replaceSemicolons) result = result.replace(/;/g, ",");
  while (Buffer.byteLength(result, "utf8") > MAX_TEXT_BYTES) {
    result = result.slice(0, -1);
  }
  return result;
}

function writeOutput(output: TerminalOutput, sequence: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      output.write(sequence, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

export function terminalLabel(name: TerminalName): string {
  switch (name) {
    case "ghostty":
      return "Ghostty";
    case "wezterm":
      return "WezTerm";
    case "kitty":
      return "kitty";
    case "iterm2":
      return "iTerm2";
  }
}

export function protocolLabel(protocol: TerminalProtocol): string {
  return protocol.toUpperCase();
}
