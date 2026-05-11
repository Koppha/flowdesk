import fs from "fs";
import path from "path";

type Level = "INFO" | "WARN" | "ERROR";

const logsDir = process.env.LOG_DIR || path.resolve(process.cwd(), "logs");
const archiveDir = path.join(logsDir, "archive");
const activeLogFile = path.join(logsDir, "app.log");
let currentLogMonth = monthKey(new Date());

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function ensureLogDirs() {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
}

function archivedLogFileForMonth(month: string) {
  let candidate = path.join(archiveDir, `app-${month}.log`);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archiveDir, `app-${month}-${index}.log`);
    index += 1;
  }
  return candidate;
}

function rotateMonthlyIfNeeded(now: Date) {
  const month = monthKey(now);
  if (month === currentLogMonth) return;
  ensureLogDirs();
  if (fs.existsSync(activeLogFile)) {
    fs.renameSync(activeLogFile, archivedLogFileForMonth(currentLogMonth));
  }
  currentLogMonth = month;
}

function writeLogLine(line: string, now: Date) {
  try {
    ensureLogDirs();
    rotateMonthlyIfNeeded(now);
    fs.appendFileSync(activeLogFile, `${line}\n`, "utf8");
  } catch (err) {
    console.error(JSON.stringify({ ts: now.toISOString(), level: "ERROR", msg: "file_log_write_failed", err: String(err) }));
  }
}

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test") return;
  const now = new Date();
  const tsLocal = now.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Africa/Maseru"
  });

  const line = JSON.stringify({
    ts: now.toISOString(),
    ts_local: tsLocal,
    level,
    msg: message,
    ...(meta ?? {})
  });
  writeLogLine(line, now);

  if (level === "ERROR") {
    console.error(line);
    return;
  }
  if (level === "WARN") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    write("INFO", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    write("WARN", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    write("ERROR", message, meta);
  }
};

export function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}
