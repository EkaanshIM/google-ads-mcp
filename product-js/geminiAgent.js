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

function defaultCustomerId() {
  return (
    process.env.DEFAULT_CUSTOMER_ID ||
    process.env.GOOGLE_ADS_DEFAULT_CUSTOMER_ID ||
    ""
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

  const systemPrefix =
    "You are a helpful Google Ads assistant. Use the provided tools to answer. " +
    "When querying data, prefer using get_resource_metadata before search to avoid guessing fields. " +
    "When calling any tool that requires customer_id, always set it to the provided customer id context. " +
    "If the user asks for the last 24 hours, approximate it using a finite range like LAST_1_DAYS. " +
    "Always include finite date ranges and LIMITs where required.";

  const effectiveCustomerId = customerId || defaultCustomerId();
  // Per request: always append the explicit clause "where customer id is ...".
  const customerClause = effectiveCustomerId
    ? `\n\nContext: where customer id is ${effectiveCustomerId}.`
    : "";

  const userText = effectiveCustomerId
    ? `Customer ID: ${effectiveCustomerId}\n\n${message}${customerClause}`
    : `${message}${customerClause}`;

  const prompt = `${systemPrefix}\n\nUser request:\n${userText}`;

  // Use the SDK's experimental built-in MCP adapter. This lets the SDK handle
  // function calling + tool execution automatically.
  const mcpClient = await getMcpClient();
  const tools = [mcpToTool(mcpClient)];

  const res1 = await ai.models.generateContent({
    model: modelName(),
    contents: prompt,
    config: { tools }
  });

  let text = extractText(res1);
  if (!text || !text.trim()) {
    // Sometimes the model completes tool calls but forgets to output a final message.
    const res2 = await ai.models.generateContent({
      model: modelName(),
      contents:
        prompt +
        "\n\nIMPORTANT: Provide a final plain-English answer summarizing the tool results. Do not return empty output.",
      config: { tools }
    });
    text = extractText(res2);
  }

  return { text };
}
