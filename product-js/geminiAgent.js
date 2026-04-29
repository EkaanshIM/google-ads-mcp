import { GoogleGenAI, mcpToTool } from "@google/genai";
import { getMcpClient } from "./mcp.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function usingVertexAi() {
  const v = String(process.env.GOOGLE_GENAI_USE_VERTEXAI || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function vertexProjectId() {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    ""
  );
}

function vertexLocation() {
  return process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_CLOUD_REGION || "global";
}

function createGenAiClient() {
  if (usingVertexAi()) {
    const project = vertexProjectId();
    if (!project) {
      throw new Error(
        "Vertex AI mode enabled but project id missing. Set GOOGLE_CLOUD_PROJECT (recommended) or GOOGLE_PROJECT_ID."
      );
    }
    // Auth is done via ADC (service account or gcloud ADC), not via GEMINI_API_KEY.
    return new GoogleGenAI({
      vertexai: true,
      project,
      location: vertexLocation()
    });
  }

  return new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
}

function modelName() {
  return process.env.GEMINI_MODEL || "gemini-2.0-flash";
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function floatEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maxOutputTokens() {
  return intEnv("GEMINI_MAX_OUTPUT_TOKENS", 1024);
}

function maxToolSteps() {
  return intEnv("GEMINI_MAX_TOOL_STEPS", 8);
}

function temperature() {
  return floatEnv("GEMINI_TEMPERATURE", 0.2);
}

function defaultCustomerId() {
  return (
    process.env.DEFAULT_CUSTOMER_ID ||
    process.env.GOOGLE_ADS_DEFAULT_CUSTOMER_ID ||
    "6475421500"
  );
}

function extractText(res) {
  const t = typeof res?.text === "function" ? res.text() : (res?.text ?? "");
  if (typeof t === "string" && t.trim()) return t;

  const parts = res?.candidates?.[0]?.content?.parts || [];
  const texts = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean);
  return texts.join("\n");
}

export async function runGeminiWithMcp({ message, customerId }) {
  const ai = createGenAiClient();

  const nowIso = new Date().toISOString();
  const effectiveCustomerId = customerId || defaultCustomerId();
  const customerInstruction = effectiveCustomerId
    ? `Default customer id context: ${effectiveCustomerId}. Use it for any tool call that requires customer_id unless the user explicitly asks for a different account. `
    : "";
  const systemPrefix =
    "You are a helpful Google Ads assistant. Use the provided tools to answer. " +
    "When querying data, prefer using get_resource_metadata before search to avoid guessing fields. " +
    customerInstruction +
    `Current timestamp (UTC): ${nowIso}. ` +
    "For count, total, how-many, or aggregate questions, prefer compact tools or minimal queries and never return large row dumps unless the user explicitly asks for rows. " +
    "If the user asks for the last 24 hours, use a finite GAQL range like DURING LAST_1_DAYS. " +
    "For change history, use resource change_event and ensure LIMIT <= 10000 and date range within last 30 days. " +
    "If the user provides a campaign id, filter change_event.change_resource_name to that campaign resource name. " +
    "Always include finite date ranges and LIMITs where required.";
  const userText = message;

  // Use the SDK's experimental built-in MCP adapter. This lets the SDK handle
  // function calling + tool execution automatically.
  const mcpClient = await getMcpClient();
  const tools = [mcpToTool(mcpClient)];
  const config = {
    tools,
    maxOutputTokens: maxOutputTokens(),
    temperature: temperature(),
    automaticFunctionCalling: {
      maximumRemoteCalls: maxToolSteps()
    }
  };

  const res1 = await ai.models.generateContent({
    model: modelName(),
    contents: userText,
    config,
    systemInstruction: systemPrefix
  });

  let text = extractText(res1);
  if (!text || !text.trim()) {
    // Sometimes the model completes tool calls but forgets to output a final message.
    const res2 = await ai.models.generateContent({
      model: modelName(),
      contents:
        userText +
        "\n\nIMPORTANT: Provide a final plain-English answer summarizing the tool results. Do not return empty output.",
      config,
      systemInstruction: systemPrefix
    });
    text = extractText(res2);
  }

  return { text };
}
