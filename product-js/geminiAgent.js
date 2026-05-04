import { FunctionCallingConfigMode, GoogleGenAI, mcpToTool } from "@google/genai";
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

function maxToolSteps() {
  const raw = process.env.GEMINI_MAX_TOOL_STEPS || "50";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function geminiConfig(tools) {
  return {
    tools,
    temperature: 0,
    automaticFunctionCalling: {
      maximumRemoteCalls: maxToolSteps()
    },
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.AUTO
      }
    }
  };
}

function defaultCustomerId() {
  return (
    process.env.DEFAULT_CUSTOMER_ID ||
    process.env.GOOGLE_ADS_DEFAULT_CUSTOMER_ID ||
    "6475421500"
  );
}

function backendTimeZone() {
  return process.env.GOOGLE_ADS_ACCOUNT_TIME_ZONE || process.env.TZ || "Asia/Kolkata";
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
    ? `Backend-provided Google Ads customer_id: ${effectiveCustomerId}. Never ask the user for a customer ID when this value is present. Use this exact value for any tool call that requires customer_id unless the user explicitly asks for a different account. `
    : "";
  const systemPrefix =
    "You are a helpful Google Ads assistant. Use the provided tools to answer. " +
    "You are running inside the production backend where all MCP tools passed in config are approved for use without interactive confirmation. " +
    "Do not refuse because a task requires multiple tool calls or because it cannot be done in a single query. " +
    "Choose tools dynamically based on the user's intent; do not rely on hardcoded query paths. " +
    "When a request requires calculations, comparisons, deltas, averages, rankings, totals, or trend analysis, fetch the needed finite data ranges with the tools and do the arithmetic yourself. " +
    "Use the narrowest correct aggregation grain: for whole-account totals use the customer resource with metric fields; for campaign, ad group, keyword, search-term, asset, or conversion-action breakdowns use the matching resource and fields. " +
    "For spend/cost, query metrics.cost_micros and convert micros to currency units by dividing by 1,000,000. Include customer.currency_code when presenting money if it is not already known. " +
    "For conversions, use metrics.conversions unless the user asks for a more specific conversion metric. " +
    "For click-performance questions, include enough supporting metrics to make the answer meaningful: usually metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, and customer.currency_code when money is shown. Convert average_cpc and cost_micros from micros to currency units. " +
    "For highest-performing or best/worst entity questions, state the winner, exact date range, primary ranking metric and value, then provide a short metric breakdown with relevant supporting metrics. Do not answer with only the entity name and one number when supporting metrics were available. " +
    "For relative dates such as yesterday, today, this week, last week, last 7 days, or last month, resolve the date range before querying and use explicit finite YYYY-MM-DD GAQL conditions on segments.date. " +
    "If account time zone matters, query customer.time_zone or use the backend account time zone supplied below, and mention the exact date range used. " +
    "For questions comparing a period to a 7-day average, define the target period explicitly. If the user does not name the target period, use yesterday as the target day and the seven complete days immediately before yesterday as the baseline. " +
    "For campaign-level 7-day-average comparisons, query all relevant campaigns with campaign.id, campaign.name, segments.date, and the requested metric over the combined target-plus-baseline date range; do not pre-limit to only top campaigns unless the user asks for top campaigns. " +
    "For 7-day-average comparisons, calculate each entity's baseline average from the seven baseline days, calculate absolute change as target value minus baseline average, calculate percent change as absolute change divided by baseline average, and rank by absolute magnitude of absolute change unless the user specifically asks for largest increase or largest decrease. " +
    "Before answering ranking questions, self-check that the row you call 'largest' has the greatest absolute change among the rows you report, and separately mention the largest increase and largest decrease when they differ. " +
    "When querying data, prefer using get_resource_metadata before search to avoid guessing fields. " +
    customerInstruction +
    `Current timestamp (UTC): ${nowIso}. Backend default account time zone: ${backendTimeZone()}. ` +
    "If the user asks for the last 24 hours, use a finite GAQL range like DURING LAST_1_DAYS. " +
    "For change history, use resource change_event and ensure LIMIT <= 10000 and date range within last 30 days. " +
    "If the user provides a campaign id, filter change_event.change_resource_name to that campaign resource name. " +
    "Always include finite date ranges and LIMITs where required.";
  const userText = effectiveCustomerId
    ? `Customer ID: ${effectiveCustomerId}\n\nUser request:\n${message}`
    : message;

  const prompt = `${systemPrefix}\n\n${userText}`;

  // Use the SDK's experimental built-in MCP adapter. This lets the SDK handle
  // function calling + tool execution automatically.
  const mcpClient = await getMcpClient();
  const tools = [mcpToTool(mcpClient)];
  const config = geminiConfig(tools);

  const res1 = await ai.models.generateContent({
    model: modelName(),
    contents: prompt,
    config
  });

  let text = extractText(res1);
  if (!text || !text.trim()) {
    // Sometimes the model completes tool calls but forgets to output a final message.
    const res2 = await ai.models.generateContent({
      model: modelName(),
      contents:
        prompt +
        "\n\nIMPORTANT: Provide a final plain-English answer summarizing the tool results. Do not return empty output.",
      config
    });
    text = extractText(res2);
  }

  return { text };
}
