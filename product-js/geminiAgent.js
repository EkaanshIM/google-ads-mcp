import { GoogleGenAI } from "@google/genai";
import { getMcpClient } from "./mcp.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function modelName() {
  return process.env.GEMINI_MODEL || "gemini-2.0-flash";
}

function toGeminiFunctionDeclarations(mcpTools) {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description || "",
    // MCP uses JSON Schema; Gemini expects OpenAPI-ish JSON schema. In practice this works
    // for simple objects. If a tool fails due to schema mismatch, we can special-case it.
    parameters: t.inputSchema || { type: "object", properties: {} }
  }));
}

async function callMcpTool(name, args) {
  const client = await getMcpClient();
  const result = await client.callTool({ name, arguments: args ?? {} });
  return result;
}

function extractText(genaiResponse) {
  if (typeof genaiResponse?.text === "string") return genaiResponse.text;
  if (typeof genaiResponse?.text === "function") return genaiResponse.text();

  const parts = genaiResponse?.candidates?.[0]?.content?.parts || [];
  const texts = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean);
  return texts.join("\n");
}

function extractFunctionCalls(genaiResponse) {
  const calls = [];
  const candidates = genaiResponse?.candidates || [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      if (p?.functionCall) calls.push(p.functionCall);
      // Be defensive: some SDKs use snake_case.
      if (p?.function_call) calls.push(p.function_call);
    }
  }
  return calls;
}

export async function runGeminiWithMcp({ message, customerId }) {
  const ai = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });

  const mcpClient = await getMcpClient();
  const listed = await mcpClient.listTools();
  const functionDeclarations = toGeminiFunctionDeclarations(listed.tools || []);

  const systemPrefix =
    "You are a helpful Google Ads assistant. Use the provided tools to answer. " +
    "When querying data, prefer using get_resource_metadata before search to avoid guessing fields. " +
    "Always include finite date ranges and LIMITs where required.";

  const userText = customerId
    ? `Customer ID: ${customerId}\n\n${message}`
    : message;

  // Tool-calling loop.
  const contents = [
    { role: "user", parts: [{ text: `${systemPrefix}\n\nUser request:\n${userText}` }] }
  ];

  const maxSteps = Number(process.env.GEMINI_MAX_TOOL_STEPS || 8);

  for (let step = 0; step < maxSteps; step++) {
    const res = await ai.models.generateContent({
      model: modelName(),
      contents,
      tools: [{ functionDeclarations }]
    });

    const calls = extractFunctionCalls(res);
    if (!calls.length) {
      return { text: extractText(res) };
    }

    // Execute all calls sequentially and feed responses back.
    for (const call of calls) {
      const toolName = call.name;
      const toolArgs = call.args || call.arguments || {};

      const toolResult = await callMcpTool(toolName, toolArgs);

      contents.push({
        role: "model",
        parts: [{ functionCall: call }]
      });
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: toolName,
              response: toolResult
            }
          }
        ]
      });
    }
  }

  return { text: "I reached the maximum tool-calling steps without finishing. Try a narrower question." };
}
