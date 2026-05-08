import { FunctionCallingConfigMode, GoogleGenAI, mcpToTool } from "@google/genai";
import { logDebugEvent, summarizeMcpResult } from "./debugLogger.js";
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

function requestPolicy(message) {
  const normalized = String(message || "").toLowerCase();
  const rules = [
    "Use tools to verify data; do not answer Google Ads counts or metrics from memory.",
    "For count-only questions, prefer count_entities/count_rows over search.",
    "For campaign ranking, product status, 7-day comparison, or account summary questions, prefer deterministic analytics tools over raw search."
  ];

  if (
    normalized.includes("campaign") &&
    (normalized.includes("running") ||
      normalized.includes("active") ||
      normalized.includes("live") ||
      normalized.includes("enabled"))
  ) {
    rules.push(
      "Campaign running/active/live/currently running count means exactly campaign.status = 'ENABLED'.",
      "Do not include PAUSED or REMOVED campaigns.",
      "Do not add campaign.serving_status, date, impression, click, cost, or conversion filters unless the user explicitly asks for serving/performance-based campaigns.",
      "Use count_entities or count_rows with resource campaign, field campaign.id, and conditions [\"campaign.status = 'ENABLED'\"] for this count."
    );
  }

  if (
    (normalized.includes("product") || normalized.includes("prod") || normalized.includes("feed") || normalized.includes("item")) &&
    (normalized.includes("count") || normalized.includes("how many") || normalized.includes("total"))
  ) {
    rules.push(
      "Product/feed count questions should count rows, not fetch row listings.",
      "Usually use count_rows with resource shopping_product and field shopping_product.resource_name.",
      "If the user asks for current date, add an explicit segments.date condition for today's YYYY-MM-DD date."
    );
  }

  if (
    (normalized.includes("product") || normalized.includes("prod") || normalized.includes("feed") || normalized.includes("item")) &&
    (normalized.includes("paused") || normalized.includes("unpaused") || normalized.includes("enabled") || normalized.includes("active"))
  ) {
    rules.push(
      "shopping_product.status does not use PAUSED, ENABLED, ACTIVE, or APPROVED.",
      "For product unpaused/enabled/active/servable counts, use shopping_product.status IN ('ELIGIBLE', 'ELIGIBLE_LIMITED').",
      "For product paused/not servable/ineligible counts, use shopping_product.status = 'NOT_ELIGIBLE' and state that this is the Google Ads eligibility equivalent, not a literal Merchant Center pause flag.",
      "Use count_products_by_status or product_status_breakdown for product eligibility counts."
    );
  }

  if (
    (normalized.includes("product") || normalized.includes("prod") || normalized.includes("feed") || normalized.includes("item")) &&
    normalized.includes("campaign") &&
    (normalized.includes("different") ||
      normalized.includes("multiple") ||
      normalized.includes("more than") ||
      normalized.includes("at least") ||
      normalized.includes("2 campaign") ||
      normalized.includes("two campaign"))
  ) {
    rules.push(
      "For products appearing/running in multiple campaigns, use count_products_in_multiple_campaigns; it scans all available Shopping and Performance Max campaigns by default.",
      "If an API field requires an equality filter, decompose the task into multiple valid scoped queries and compare/count results in code.",
      "Do not refuse just because the comparison cannot be expressed in one GAQL query.",
      "If count_products_in_multiple_campaigns returns is_partial=true, answer with the partial count and clearly say how many campaigns were scanned versus available."
    );
  }

  if (
    (normalized.includes("product") || normalized.includes("prod") || normalized.includes("feed") || normalized.includes("item")) &&
    (normalized.includes("issue") || normalized.includes("disapproved") || normalized.includes("unavailable"))
  ) {
    rules.push(
      "For product issue count questions, use count_products_by_issue with the user's issue text.",
      "shopping_product.issues can be selected and scanned even when it cannot be used as a GAQL filter.",
      "Do not replace a specific issue count with a broad NOT_ELIGIBLE count unless the issue field cannot be fetched."
    );
  }

  if (normalized.includes("7day") || normalized.includes("7-day") || normalized.includes("7 day")) {
    rules.push(
      "For 7-day-average comparisons, use yesterday as target when no target day is named and the seven complete days before yesterday as baseline.",
      "Rank largest change by absolute magnitude unless the user asks specifically for increase or decrease."
    );
  }

  if (
    normalized.includes("campaign") &&
    (normalized.includes("best") ||
      normalized.includes("worst") ||
      normalized.includes("top") ||
      normalized.includes("bottom") ||
      normalized.includes("highest") ||
      normalized.includes("lowest") ||
      normalized.includes("performing") ||
      normalized.includes("performance"))
  ) {
    rules.push(
      "For campaign best/worst/top/bottom performance questions, do not use an unordered limited sample. Add campaign.status = 'ENABLED' unless the user asks for all campaign statuses.",
      "Prefer the rank_campaigns tool for campaign best/worst/top/bottom performance questions.",
      "Fetch enough rows to rank the full candidate set; use limit 1000 or higher for campaign-level ranking unless a smaller top-N is explicitly paired with ORDER BY on the ranking metric.",
      "Include supporting fields: campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, and customer.currency_code when available.",
      "If the user does not specify a ranking metric, rank best by a balanced performance view using conversions, cost efficiency, clicks, CTR, and CPC; state the primary metric/scoring rule used.",
      "Never conclude all campaigns have zero activity from a limited or unordered campaign sample. If campaign rows appear all zero, run a customer-level sanity query for the same date with clicks, impressions, cost, and conversions before answering."
    );
  }

  if (
    normalized.includes("campaign") &&
    (normalized.includes("recommend") ||
      normalized.includes("modification") ||
      normalized.includes("modify") ||
      normalized.includes("what went right") ||
      normalized.includes("what went wrong") ||
      normalized.includes("right and wrong") ||
      normalized.includes("improve") ||
      normalized.includes("optimise") ||
      normalized.includes("optimize"))
  ) {
    rules.push(
      "For campaign diagnostic reporting, what-went-right/wrong, and recommendation questions, use diagnose_campaign_period when the user provides or implies a finite date range.",
      "Do provide practical recommended modifications when grounded in fetched metrics. Phrase them as suggested optimizations, not guaranteed outcomes.",
      "Base recommendations on clicks, impressions, cost, conversions, CTR, average CPC, conversion rate, CPA, and trend deltas; do not refuse only because business goals are not fully known.",
      "If business context is missing, still provide metric-based recommendations and clearly mention that final action should consider margins, inventory, conversion quality, and business priorities."
    );
  }

  return rules.map((rule) => `- ${rule}`).join("\n");
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

function includeTraceInResponse() {
  const value = String(process.env.DEBUG_TRACE_IN_RESPONSE || "false").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

function formatExecutionTrace({ customerId, understanding, toolCalls }) {
  const lines = [
    "",
    "",
    "---",
    "Execution trace",
    "",
    "What I understood / applied:",
    understanding || "- No special request policy."
  ];

  if (!toolCalls.length) {
    lines.push("", "MCP tools used:", "- None");
    return lines.join("\n");
  }

  lines.push("", "MCP tools used:");
  toolCalls.forEach((call, index) => {
    lines.push(
      "",
      `${index + 1}. ${call.toolName}`,
      `Customer ID: ${customerId || "not provided"}`,
      "Arguments:",
      compactJson(call.toolArguments || {})
    );
    if (call.result) {
      lines.push("Result summary:", compactJson(call.result));
    }
    if (call.error) {
      lines.push(`Error: ${call.error}`);
    }
  });

  return lines.join("\n");
}

function instrumentMcpClient(mcpClient, context) {
  const callTool = async (request, options) => {
    const startedAt = new Date().toISOString();
    const { toolCalls: trace, ...logContext } = context;
    const traceEntry = {
      startedAt,
      toolName: request?.name,
      toolArguments: request?.arguments || {}
    };
    trace?.push(traceEntry);

    await logDebugEvent("gemini.mcp_tool_call", {
      ...logContext,
      startedAt,
      toolName: request?.name,
      toolArguments: request?.arguments || {}
    });

    try {
      const result = await mcpClient.callTool.call(mcpClient, request, options);
      traceEntry.completedAt = new Date().toISOString();
      traceEntry.result = summarizeMcpResult(result);
      await logDebugEvent("gemini.mcp_tool_result", {
        ...logContext,
        startedAt,
        completedAt: traceEntry.completedAt,
        toolName: request?.name,
        toolArguments: request?.arguments || {},
        result: traceEntry.result
      });
      return result;
    } catch (error) {
      traceEntry.completedAt = new Date().toISOString();
      traceEntry.error = error?.message ?? String(error);
      await logDebugEvent("gemini.mcp_tool_error", {
        ...logContext,
        startedAt,
        completedAt: traceEntry.completedAt,
        toolName: request?.name,
        toolArguments: request?.arguments || {},
        error: traceEntry.error
      });
      throw error;
    }
  };

  return new Proxy(mcpClient, {
    get(target, prop, receiver) {
      if (prop === "callTool") return callTool;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export async function runGeminiWithMcp({ message, customerId, jobId }) {
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
    "Always aim for a useful, decision-ready answer: answer the user's direct question first, then add the most meaningful supporting insights available from the fetched data. " +
    "When tool results include relevant supporting metrics, include them instead of giving a bare one-line answer. Prefer concise tables or bullets for ranked results, comparisons, winners/losers, anomalies, and performance summaries. " +
    "For every data answer, include the account/customer when known, the exact date range used, the primary metric used to rank or decide, and any important caveat such as missing data, zero baseline, partial current-day data, or a metric that cannot be inferred. " +
    "When there are meaningful patterns, mention the top positive driver, top negative driver, and one practical takeaway; keep this grounded in the fetched tool data and do not invent causes. " +
    "For count questions such as total count, how many, inventory size, product count, product/feed count, or item count, use count_rows instead of search whenever a row-level listing is not needed. Never fetch all matching product/feed rows just to count them. For product/feed counts, usually use the shopping_product resource and a selectable identifier field such as shopping_product.resource_name; add explicit segments.date conditions when the user asks for a date-specific count. " +
    "Prefer deterministic analytics tools when available: count_entities for entity counts, rank_campaigns for campaign best/worst/top/bottom performance, diagnose_campaign_period for campaign diagnostic reporting and recommendations, compare_campaigns_to_7day_average for campaign 7-day average comparisons, product_status_breakdown, count_products_by_status, and count_products_in_multiple_campaigns for Merchant Center product eligibility/campaign-overlap counts, and account_metric_summary for account-level metric totals. Use raw search only when a deterministic tool does not fit. " +
    "When a Google Ads field requires an equality filter, scoped query, or cannot be used for a cross-entity comparison in one GAQL query, decompose the task into multiple valid tool queries and post-process/count/rank/compare the fetched results. Do not refuse solely because the comparison cannot be done in a single query. " +
    "If a deterministic tool returns partial results to avoid timeout, present the partial result with the scanned/available scope rather than failing. " +
    "For product issue questions, use count_products_by_issue. If a selected field is not filterable, do not refuse; fetch the selectable field with a finite tool strategy and post-process/count server-side using the deterministic tool. " +
    "For Merchant Center product enabled/unpaused/servable/active product questions in Google Ads, use shopping_product.status values from ProductStatus: ELIGIBLE means can show in ads, ELIGIBLE_LIMITED means can show with limitations, and NOT_ELIGIBLE means cannot show. Do not try PAUSED, ENABLED, ACTIVE, or APPROVED for shopping_product.status. For enabled/unpaused product counts, usually count shopping_product rows where shopping_product.status IN ('ELIGIBLE', 'ELIGIBLE_LIMITED') unless the user wants only fully eligible products, in which case use shopping_product.status = 'ELIGIBLE'. For paused/not servable/ineligible product counts, count shopping_product.status = 'NOT_ELIGIBLE' and explain that Google Ads exposes this as eligibility, not a literal product pause flag. " +
    "For campaign status questions, interpret running, active, live, currently running, or enabled campaigns as campaign.status = 'ENABLED'. Do not include PAUSED or REMOVED campaigns in a running/active/live count unless the user explicitly asks for paused, inactive, all statuses, or a status breakdown. " +
    "For simple campaign counts, use count_rows on the campaign resource with field campaign.id and the appropriate status condition instead of fetching every campaign row. " +
    "For broad listing questions, request only the fields needed, always use a LIMIT, and summarize instead of returning huge raw result sets. If the user asks for all rows and the result may be large, ask them to narrow the request or provide a small sample with the total count. " +
    "When a request requires calculations, comparisons, deltas, averages, rankings, totals, or trend analysis, fetch the needed finite data ranges with the tools and do the arithmetic yourself. " +
    "Use the narrowest correct aggregation grain: for whole-account totals use the customer resource with metric fields; for campaign, ad group, keyword, search-term, asset, or conversion-action breakdowns use the matching resource and fields. " +
    "For spend/cost, query metrics.cost_micros and convert micros to currency units by dividing by 1,000,000. Include customer.currency_code when presenting money if it is not already known. " +
    "For conversions, use metrics.conversions unless the user asks for a more specific conversion metric. " +
    "For click-performance questions, include enough supporting metrics to make the answer meaningful: usually metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, and customer.currency_code when money is shown. Convert average_cpc and cost_micros from micros to currency units. " +
    "For highest-performing or best/worst entity questions, state the winner, exact date range, primary ranking metric and value, then provide a short metric breakdown with relevant supporting metrics. Do not answer with only the entity name and one number when supporting metrics were available. " +
    "For campaign best/worst/top/bottom performance questions, never rank from an unordered limited sample. Use campaign.status = 'ENABLED' by default, fetch a complete candidate set with a large enough limit, and include clicks, impressions, CTR, average CPC, cost, and conversions. If a fetched sample shows all zero metrics, verify with a customer-level totals query for the same date before saying all campaigns had zero activity. " +
    "For campaign recommendation questions, produce decision-ready diagnostic reporting: summarize what went right, what went wrong, likely metric-based reasons, and suggested modifications. Keep recommendations grounded in tool data and say they should be validated against business goals, margins, inventory, and conversion quality. " +
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
  const understanding = requestPolicy(message);
  const userText = effectiveCustomerId
    ? `Customer ID: ${effectiveCustomerId}\n\nCritical query policy for this request:\n${understanding}\n\nUser request:\n${message}`
    : `Critical query policy for this request:\n${understanding}\n\nUser request:\n${message}`;

  const prompt = `${systemPrefix}\n\n${userText}`;
  const toolCalls = [];
  const context = {
    jobId: jobId || null,
    customerId: effectiveCustomerId || null,
    userMessage: message,
    toolCalls
  };
  const { toolCalls: _toolCalls, ...logContext } = context;

  await logDebugEvent("gemini.prompt_prepared", {
    ...logContext,
    model: modelName(),
    prompt
  });

  // Use the SDK's experimental built-in MCP adapter. This lets the SDK handle
  // function calling + tool execution automatically.
  const mcpClient = await getMcpClient();
  const tools = [mcpToTool(instrumentMcpClient(mcpClient, context))];
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

  const debugTrace = {
    customerId: effectiveCustomerId || null,
    understanding,
    toolCalls
  };
  const finalText = includeTraceInResponse()
    ? `${text || ""}${formatExecutionTrace(debugTrace)}`
    : text;

  return { text: finalText, debugTrace };
}
