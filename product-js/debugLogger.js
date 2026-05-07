import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logFile = process.env.DEBUG_LOG_FILE || path.join(__dirname, "data", "debug-events.jsonl");
const maxChars = Number.parseInt(process.env.DEBUG_LOG_MAX_CHARS || "20000", 10);

function truncateString(value, limit = maxChars) {
  if (typeof value !== "string") return value;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[MaxDepth]";
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => compactValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [key, compactValue(item, depth + 1)])
    );
  }
  return String(value);
}

export function summarizeMcpResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const firstText = content.find((part) => part?.type === "text" && typeof part.text === "string")?.text || "";
  return {
    isError: Boolean(result?.isError),
    contentCount: content.length,
    textPreview: truncateString(firstText, 4000),
    structuredContent: compactValue(result?.structuredContent)
  };
}

export async function logDebugEvent(type, payload = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    type,
    ...compactValue(payload)
  };

  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write debug log", error);
  }
}

export { logFile as debugLogFile };
