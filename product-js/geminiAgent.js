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

export async function runGeminiWithMcp({ message, customerId }) {
  const ai = createGenAiClient();

  const systemPrefix =
    "You are a helpful Google Ads assistant. Use the provided tools to answer. " +
    "When querying data, prefer using get_resource_metadata before search to avoid guessing fields. " +
    "Always include finite date ranges and LIMITs where required.";

  const userText = customerId
    ? `Customer ID: ${customerId}\n\n${message}`
    : message;

  const prompt = `${systemPrefix}\n\nUser request:\n${userText}`;

  // Use the SDK's experimental built-in MCP adapter. This lets the SDK handle
  // function calling + tool execution automatically.
  const mcpClient = await getMcpClient();
  const tools = [mcpToTool(mcpClient)];

  const res = await ai.models.generateContent({
    model: modelName(),
    contents: prompt,
    config: { tools }
  });

  const text =
    typeof res?.text === "function" ? res.text() : (res?.text ?? "");

  return { text };
}
