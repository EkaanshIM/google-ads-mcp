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

function modelPricingUsdPerMillionTokens(model) {
  const normalized = String(model || "").toLowerCase();
  if (normalized.includes("gemini-2.5-flash-lite")) {
    return {
      input: 0.10,
      output: 0.40,
      source: "Vertex AI official Gemini 2.5 Flash Lite standard text token pricing"
    };
  }

  if (normalized.includes("gemini-2.5-flash")) {
    return {
      input: 0.30,
      output: 2.50,
      source: "Vertex AI official Gemini 2.5 Flash standard text token pricing"
    };
  }

  if (normalized.includes("gemini-2.0-flash")) {
    return {
      input: 0.15,
      output: 0.60,
      source: "Vertex AI official Gemini 2.0 Flash text token pricing"
    };
  }

  return {
    input: null,
    output: null,
    source: "unknown model pricing"
  };
}

function numericUsageField(usage, field) {
  const value = Number(usage?.[field]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageFromResponse(res) {
  const usage = res?.usageMetadata || {};
  const promptTokens = numericUsageField(usage, "promptTokenCount");
  const candidatesTokens = numericUsageField(usage, "candidatesTokenCount");
  const thoughtsTokens = numericUsageField(usage, "thoughtsTokenCount");
  const toolUsePromptTokens = numericUsageField(usage, "toolUsePromptTokenCount");
  const cachedContentTokens = numericUsageField(usage, "cachedContentTokenCount");
  const totalTokens = numericUsageField(usage, "totalTokenCount");
  return {
    promptTokens,
    candidatesTokens,
    thoughtsTokens,
    toolUsePromptTokens,
    cachedContentTokens,
    totalTokens,
    raw: usage
  };
}

function addUsage(left, right) {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    candidatesTokens: left.candidatesTokens + right.candidatesTokens,
    thoughtsTokens: left.thoughtsTokens + right.thoughtsTokens,
    toolUsePromptTokens: left.toolUsePromptTokens + right.toolUsePromptTokens,
    cachedContentTokens: left.cachedContentTokens + right.cachedContentTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    raw: [...left.raw, right.raw].filter((item) => item && Object.keys(item).length)
  };
}

function modelUsage(responses, purpose) {
  const model = modelName();
  const empty = {
    promptTokens: 0,
    candidatesTokens: 0,
    thoughtsTokens: 0,
    toolUsePromptTokens: 0,
    cachedContentTokens: 0,
    totalTokens: 0,
    raw: []
  };
  const tokens = responses.filter(Boolean).map(usageFromResponse).reduce(addUsage, empty);
  const outputTokens = tokens.candidatesTokens + tokens.thoughtsTokens;
  const fallbackTotal = tokens.promptTokens + outputTokens + tokens.toolUsePromptTokens;
  const totalTokens = tokens.totalTokens || fallbackTotal;
  const pricing = modelPricingUsdPerMillionTokens(model);
  const inputCost =
    pricing.input == null ? null : ((tokens.promptTokens + tokens.toolUsePromptTokens) / 1_000_000) * pricing.input;
  const outputCost = pricing.output == null ? null : (outputTokens / 1_000_000) * pricing.output;
  const estimatedCostUsd =
    inputCost == null || outputCost == null ? null : Number((inputCost + outputCost).toFixed(8));

  return {
    purpose,
    model,
    tokens: {
      input: tokens.promptTokens + tokens.toolUsePromptTokens,
      output: outputTokens,
      total: totalTokens,
      prompt: tokens.promptTokens,
      candidates: tokens.candidatesTokens,
      thoughts: tokens.thoughtsTokens,
      toolUsePrompt: tokens.toolUsePromptTokens,
      cachedContent: tokens.cachedContentTokens
    },
    cost: {
      estimatedUsd: estimatedCostUsd,
      inputUsd: inputCost == null ? null : Number(inputCost.toFixed(8)),
      outputUsd: outputCost == null ? null : Number(outputCost.toFixed(8)),
      pricingUsdPerMillionTokens: {
        input: pricing.input,
        output: pricing.output
      },
      pricingSource: pricing.source
    },
    rawUsageMetadata: tokens.raw
  };
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

function accountDateFromOffset(dayOffset = 0, timeZone = backendTimeZone()) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value || "0");
  const month = Number(parts.find((part) => part.type === "month")?.value || "0");
  const day = Number(parts.find((part) => part.type === "day")?.value || "0");
  const baseUtc = Date.UTC(year, Math.max(0, month - 1), Math.max(1, day));
  return new Date(baseUtc + dayOffset * 86400000).toISOString().slice(0, 10);
}

function backendRelativeDateContext() {
  const timeZone = backendTimeZone();
  const today = accountDateFromOffset(0, timeZone);
  const yesterday = accountDateFromOffset(-1, timeZone);
  const sevenDayBaselineStart = accountDateFromOffset(-8, timeZone);
  const sevenDayBaselineEnd = accountDateFromOffset(-2, timeZone);
  return {
    timeZone,
    today,
    yesterday,
    sevenDayBaselineStart,
    sevenDayBaselineEnd
  };
}

function hasExplicitEntityScope(message = "") {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("campaign") ||
    normalized.includes("ad group") ||
    normalized.includes("adgroup") ||
    normalized.includes("keyword") ||
    normalized.includes("search term") ||
    normalized.includes("product")
  );
}

function isAccountLevelMetricRequest(message = "") {
  const normalized = String(message || "").toLowerCase();
  const metricHints = [
    "conversion",
    "conversions",
    "click",
    "clicks",
    "impression",
    "impressions",
    "spend",
    "cost",
    "ctr",
    "cpc",
    "cpa",
    "roas",
    "revenue"
  ];
  const hasMetricHint = metricHints.some((token) => normalized.includes(token));
  const hasDateHint =
    normalized.includes("yesterday") ||
    normalized.includes("today") ||
    normalized.includes("last 7") ||
    normalized.includes("7 day") ||
    /\b20\d{2}-\d{2}-\d{2}\b/.test(normalized) ||
    /\b(on|for)\s+\d{1,2}(st|nd|rd|th)?\b/.test(normalized);
  return hasMetricHint && hasDateHint && !hasExplicitEntityScope(normalized);
}

function enforceAccountLevelUnderstandingText(text = "", message = "", customerId = "") {
  if (!isAccountLevelMetricRequest(message)) return text;
  let out = String(text || "").trim();
  out = out.replace(/\s+in\s+the\s+["“][^"”\n]{2,160}["”]\s+campaign/gi, "");
  out = out.replace(/\s+in\s+the\s+[^,.\n]{2,160}\s+campaign/gi, "");
  if (!/account level|customer level/i.test(out)) {
    out += `\nI will run this at account level${customerId ? ` for customer ${customerId}` : ""}.`;
  }
  return out;
}

function isDeclineReasonIntent(message = "") {
  const normalized = String(message || "").toLowerCase();
  const asksReason =
    normalized.includes("why") ||
    normalized.includes("reason") ||
    normalized.includes("what led") ||
    normalized.includes("what caused") ||
    normalized.includes("root cause");
  const mentionsDrop =
    normalized.includes("decline") ||
    normalized.includes("drop") ||
    normalized.includes("decrease") ||
    normalized.includes("down");
  return asksReason && mentionsDrop;
}

function hasPrematureLimitationText(text = "") {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("cannot pinpoint") ||
    normalized.includes("technical limitation") ||
    normalized.includes("lack access") ||
    normalized.includes("cannot determine the exact") ||
    normalized.includes("i can't determine the exact") ||
    normalized.includes("confirm before i process")
  );
}

function deterministicUnderstandingFallback(message = "", customerId = "", relativeDates = null) {
  const normalized = String(message || "").toLowerCase();
  const cidText = customerId ? ` for customer ${customerId}` : "";

  if (isDeclineReasonIntent(normalized)) {
    const baselineStart = relativeDates?.sevenDayBaselineStart || "";
    const baselineEnd = relativeDates?.sevenDayBaselineEnd || "";
    const targetDate = relativeDates?.yesterday || "";
    return [
      `I will analyze the decline drivers${cidText} using account performance data.`,
      targetDate && baselineStart && baselineEnd
        ? `I will compare ${targetDate} against the prior 7-day baseline (${baselineStart} to ${baselineEnd}) and identify the largest negative contributors.`
        : "I will compare the target period against the prior baseline and identify the largest negative contributors.",
      "I will return concrete entities and metrics (campaigns/ad groups/search terms/products), not generic possible reasons."
    ].join("\n");
  }

  if (normalized.includes("conversion") || normalized.includes("conversions")) {
    return `I will fetch the requested conversion metrics${cidText} using the exact date scope in your query.`;
  }

  return `I will process this request${cidText} using Google Ads data and return concrete, metric-backed findings.`;
}

function enforceConcreteUnderstandingText(text = "", message = "", customerId = "", relativeDates = null) {
  const current = String(text || "").trim();
  if (!hasPrematureLimitationText(current)) return current;
  return deterministicUnderstandingFallback(message, customerId, relativeDates);
}

function formatConversationContext(history = []) {
  if (!Array.isArray(history) || !history.length) return "";

  const recentTurns = history
    .slice(-8)
    .map((turn) => {
      const role = turn?.role === "assistant" ? "Assistant" : "User";
      const text = String(turn?.text || "").trim().replace(/\s+/g, " ");
      return text ? `${role}: ${text.slice(0, 2500)}` : "";
    })
    .filter(Boolean);

  return recentTurns.length
    ? `Recent conversation context. This is active session memory, not background trivia. Use it to resolve follow-up questions, pronouns, omitted date ranges, campaign references, metrics, products, keywords, and prior recommendations. If the latest user asks a short follow-up like "what about spending", infer the same account and date range/entity from the immediately previous relevant turn. Do not ask for a date range or entity that is already clear from this context. For account-level metric asks (for example "what was conversion on 2026-05-21"), do not inherit campaign scope unless the user explicitly asks campaign/ad group level.\n${recentTurns.join("\n")}`
    : "";
}

function isCountStyleRequest(message = "") {
  const normalized = String(message || "").toLowerCase();
  const asksCount =
    normalized.includes("how many") ||
    normalized.includes("count") ||
    normalized.includes("number of") ||
    normalized.includes("total number") ||
    normalized.startsWith("find the number") ||
    normalized.startsWith("what is the number");
  const asksListing = normalized.includes("show") || normalized.includes("list") || normalized.includes("which");
  return asksCount && !normalized.includes("analy") && !normalized.includes("why") && !normalized.includes("reason") && !asksListing;
}

function isAnalysisStyleRequest(message = "") {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("analy") ||
    normalized.includes("what happened") ||
    normalized.includes("yesterday happened") ||
    normalized.includes("why") ||
    normalized.includes("reason") ||
    normalized.includes("stable") ||
    normalized.includes("good or bad") ||
    normalized.includes("performance")
  );
}

function requestPolicy(message) {
  const normalized = String(message || "").toLowerCase();
  const rules = [
    "Use tools to verify data; do not answer Google Ads counts or metrics from memory.",
    "If this is a follow-up question, use recent conversation context to resolve omitted date ranges, account, campaign, product, keyword, or metric references before asking a clarification.",
    "For count-only questions, prefer count_entities/count_rows over search.",
    "For campaign ranking, product status, 7-day comparison, or account summary questions, prefer deterministic analytics tools over raw search.",
    "Always present Google Ads money values as INR; never use $ or USD for this account."
  ];

  if (isCountStyleRequest(normalized)) {
    rules.push(
      "This is a count/lookup request. Return the exact count and the minimum supporting facts only.",
      "Do not add diagnosis, causes, operational warnings, strategic recommendations, or unrelated account history unless the user explicitly asks for analysis.",
      "Do not mention tool internals or invented context."
    );
  }

  if (isAnalysisStyleRequest(normalized)) {
    rules.push(
      "This is an analysis request. Explain whether performance was stable, improving, or worsening, and support that with fetched metrics and date ranges.",
      "When the user asks what happened yesterday or similar, fetch the exact period and compare it to a relevant baseline when available.",
      "Include the concrete drivers, then give a concise takeaway and next action if the data supports it."
    );
  }

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
      "For boost plans, business-growth decisions, exact keyword/search-term suggestions, bid changes, budget increases, or expected impact estimates, use campaign_growth_decision_brief. Use it even when diagnose_campaign_period says performance is stable.",
      "Do provide practical recommended modifications when grounded in fetched metrics. Phrase them as suggested optimizations, not guaranteed outcomes.",
      "Base recommendations on clicks, impressions, cost, conversions, CTR, average CPC, conversion rate, CPA, and trend deltas; do not refuse only because business goals are not fully known.",
      "Avoid generic advice like 'refresh creatives' or 'review keywords' unless it is tied to the exact campaigns, products, search terms, keywords, ad groups, or metrics that changed.",
      "When the user asks for deeper insight, drill down into the concrete drivers available through tools: products that started dropping, products with clicks and no conversions, rising-cost or falling-CTR keywords, search terms wasting spend, winning terms to scale, and campaign/ad group segments causing the trend.",
      "For each recommendation, include what to change, how to do it, why the data supports it, the expected directional impact, and what metric/date range to monitor after the change.",
      "When recommending keyword changes, name the actual keyword/search term text from fetched data. For expansion, suggest exact candidate keywords or search terms only when they are derived from working search terms, converting products, landing page/product text available in fetched data, or clearly labeled as hypotheses.",
      "When recommending bid or price changes, calculate a numeric recommended range from available data such as current CPC, CPA, conversion rate, target CPA, margin, conversion value, or ROAS. If margin/target CPA is missing, state the formula and provide a conservative metric-based range, not a single unsupported number.",
      "If performance is stable and CPA/conversion volume is acceptable, recommend a controlled scale test such as a 5-20% budget or bid increase with CPA guardrails and expected incremental conversions calculated from observed CPA.",
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
    const { toolCalls: trace, onPhase, ...logContext } = context;
    const traceEntry = {
      startedAt,
      toolName: request?.name,
      toolArguments: request?.arguments || {}
    };
    trace?.push(traceEntry);
    await onPhase?.("ads");

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

export async function runGeminiWithMcp({ message, finalQuery = "", customerId, jobId, conversationHistory = [], onPhase }) {
  const ai = createGenAiClient();

  const nowIso = new Date().toISOString();
  const relativeDates = backendRelativeDateContext();
  const effectiveCustomerId = customerId || defaultCustomerId();
  const customerInstruction = effectiveCustomerId
    ? `Backend-provided Google Ads customer_id: ${effectiveCustomerId}. Never ask the user for a customer ID when this value is present. Use this exact value for any tool call that requires customer_id unless the user explicitly asks for a different account. `
    : "";
  const systemPrefix =
    "You are a helpful Google Ads assistant. Use the provided tools to answer. " +
    "You are running inside the production backend where all MCP tools passed in config are approved for use without interactive confirmation. " +
    "Do not refuse because a task requires multiple tool calls or because it cannot be done in a single query. " +
    "Choose tools dynamically based on the user's intent; do not rely on hardcoded query paths. " +
    "Always answer the user's direct question first. Then decide how much detail to add based on the request: keep count/lookup answers short and exact, and give fuller diagnostic detail only for analysis or optimization questions. " +
    "Accuracy matters more than sounding confident. Never invent campaigns, products, keywords, search terms, prices, bids, causes, expected impact, people, companies, account events, or verification issues. If a claim is not supported by tool results or explicit conversation context, omit it. If a recommendation needs data that is not yet available, fetch it with tools when possible; otherwise label the missing input and give the exact formula or next query needed. " +
    "Treat recent conversation context as active memory. For follow-up questions, inherit the prior account, date range, campaign/product/keyword scope, and metric subject when the user omits them. Example: after 'help me with yesterday conversion', 'what about spending' means spending for the same customer and yesterday. Important: do not inherit campaign/ad-group/product scope for account-level metric questions unless the user explicitly asks for that entity scope. " +
    "When tool results include relevant supporting metrics, include them for analysis questions. Prefer concise tables or bullets for ranked results, comparisons, winners/losers, anomalies, and performance summaries. For count questions, do not expand into broad commentary unless asked. " +
    "For every data answer, include the account/customer when known, the exact date range used, the primary metric used to rank or decide, and any important caveat such as missing data, zero baseline, partial current-day data, or a metric that cannot be inferred. " +
    "When there are meaningful patterns in analysis questions, mention the top positive driver, top negative driver, and one practical takeaway; keep this grounded in the fetched tool data and do not invent causes. " +
    "For optimization and diagnostic answers, be specific before being strategic. Name the actual campaigns, ad groups, products, search terms, keywords, assets, or segments that are driving the metric change when tools can fetch them. " +
    "Do not stop at generic advice. For every major recommendation, include: evidence from the data, the exact change to make, how to make it in Google Ads or the feed, expected directional impact, risk/guardrail, and what to check next. " +
    "When the data needed for a detailed diagnosis is not yet fetched, run additional focused drill-down queries before answering instead of saying to 'review' something. Useful drill-downs include product trend drops, dead-click products with spend/clicks and zero conversions, search terms with spend and no conversions, keywords with rising CPC or falling CTR, and products/terms that gained conversions efficiently. " +
    "For keyword advice, do not say 'add new keywords' generically. Provide actual keyword/search term text from fetched search term or keyword data, identify match type suggestions when reasonable, and separate scale candidates from negative keyword candidates. " +
    "For bid or pricing advice, do not say 'adjust bids' generically. Provide a numeric bid/CPC/CPA/ROAS range when data supports it, explain the calculation, and include a guardrail such as max CPC, target CPA, or minimum conversion volume. If the account uses Smart Bidding and manual CPC is not applicable, recommend target CPA/ROAS or budget changes instead of fake keyword-level CPCs. " +
    "Use clear readable formatting with short sections, tables where helpful, and action bullets that start with a verb. " +
    "For count questions such as total count, how many, inventory size, product count, product/feed count, or item count, use count_rows instead of search whenever a row-level listing is not needed. Never fetch all matching product/feed rows just to count them. For product/feed counts, usually use the shopping_product resource and a selectable identifier field such as shopping_product.resource_name; add explicit segments.date conditions when the user asks for a date-specific count. " +
    "Prefer deterministic analytics tools when available: count_entities for entity counts, rank_campaigns for campaign best/worst/top/bottom performance, diagnose_campaign_period for campaign diagnostic reporting and recommendations, campaign_growth_decision_brief for boost plans, exact search-term/keyword actions, bid/budget decisions, and expected impact estimates, compare_campaigns_to_7day_average for campaign 7-day average comparisons, product_status_breakdown, count_products_by_status, and count_products_in_multiple_campaigns for Merchant Center product eligibility/campaign-overlap counts, and account_metric_summary for account-level metric totals. Use raw search only when a deterministic tool does not fit. " +
    "All Google Ads currency values in this app must be presented as INR. Never use $, USD, or any non-INR currency symbol for cost, spend, CPC, CPA, or budget values. If a tool returns numeric cost values, label them as INR. " +
    "When a Google Ads field requires an equality filter, scoped query, or cannot be used for a cross-entity comparison in one GAQL query, decompose the task into multiple valid tool queries and post-process/count/rank/compare the fetched results. Do not refuse solely because the comparison cannot be done in a single query. " +
    "If a deterministic tool returns partial results to avoid timeout, present the partial result with the scanned/available scope rather than failing. " +
    "For product issue questions, use count_products_by_issue. If a selected field is not filterable, do not refuse; fetch the selectable field with a finite tool strategy and post-process/count server-side using the deterministic tool. " +
    "For Merchant Center product enabled/unpaused/servable/active product questions in Google Ads, use shopping_product.status values from ProductStatus: ELIGIBLE means can show in ads, ELIGIBLE_LIMITED means can show with limitations, and NOT_ELIGIBLE means cannot show. Do not try PAUSED, ENABLED, ACTIVE, or APPROVED for shopping_product.status. For enabled/unpaused product counts, usually count shopping_product rows where shopping_product.status IN ('ELIGIBLE', 'ELIGIBLE_LIMITED') unless the user wants only fully eligible products, in which case use shopping_product.status = 'ELIGIBLE'. For paused/not servable/ineligible product counts, count shopping_product.status = 'NOT_ELIGIBLE' and explain that Google Ads exposes this as eligibility, not a literal product pause flag. " +
    "For campaign status questions, interpret running, active, live, currently running, or enabled campaigns as campaign.status = 'ENABLED'. Do not include PAUSED or REMOVED campaigns in a running/active/live count unless the user explicitly asks for paused, inactive, all statuses, or a status breakdown. " +
    "For simple campaign counts, use count_rows on the campaign resource with field campaign.id and the appropriate status condition instead of fetching every campaign row. " +
    "For broad listing questions, request only the fields needed, always use a LIMIT, and summarize instead of returning huge raw result sets. If the user asks for all rows and the result may be large, ask them to narrow the request or provide a small sample with the total count. " +
    "When a user requests ad group, keyword, or search-term breakdowns across many campaigns and the dataset may be large, ask for one specific campaign before running deep breakdown queries. If the user still wants all campaigns, offer a broad campaign preview only when it helps narrowing; do not force a top-5 preview when the user already named a specific campaign. " +
    "When a request requires calculations, comparisons, deltas, averages, rankings, totals, or trend analysis, fetch the needed finite data ranges with the tools and do the arithmetic yourself. " +
    "Use the narrowest correct aggregation grain: for whole-account totals use the customer resource with metric fields; for campaign, ad group, keyword, search-term, asset, or conversion-action breakdowns use the matching resource and fields. " +
    "For spend/cost, query metrics.cost_micros and convert micros to currency units by dividing by 1,000,000. Present money as INR even if customer.currency_code is missing or unexpected. " +
    "For conversions, use metrics.conversions unless the user asks for a more specific conversion metric. " +
    "For spending, spend, cost, or budget follow-up questions, use metrics.cost_micros over the resolved date range and convert to INR. If the user says 'what about spending' after a previous dated metric question, use the previous date range instead of asking again. " +
    "For click-performance questions, include enough supporting metrics to make the answer meaningful: usually metrics.clicks, metrics.ctr, metrics.average_cpc, and metrics.cost_micros. Convert average_cpc and cost_micros from micros to currency units and present them as INR. " +
    "For highest-performing or best/worst entity questions, state the winner, exact date range, primary ranking metric and value, then provide a short metric breakdown with relevant supporting metrics. Do not answer with only the entity name and one number when supporting metrics were available. " +
    "For campaign best/worst/top/bottom performance questions, never rank from an unordered limited sample. Use campaign.status = 'ENABLED' by default, fetch a complete candidate set with a large enough limit, and include clicks, impressions, CTR, average CPC, cost, and conversions. If a fetched sample shows all zero metrics, verify with a customer-level totals query for the same date before saying all campaigns had zero activity. " +
    "For campaign recommendation and analysis questions, produce decision-ready diagnostic reporting: summarize what went right, what went wrong, likely metric-based reasons, and suggested modifications. Keep recommendations grounded in tool data and say they should be validated against business goals, margins, inventory, and conversion quality. " +
    "For boost/business-growth questions, call campaign_growth_decision_brief and return concrete actions: exact search terms to scale or negative, bid/CPC range or budget lift percentage, expected incremental conversion formula/range, risk guardrail, and monitoring rule. Do not answer that a stable campaign has nothing to do; stable performance should lead to a controlled scale test when CPA and conversion volume support it. " +
    "Recommended structure for campaign diagnostics: Executive read, What improved, What declined, Specific drivers, Dead-click/wasted-spend opportunities, Working keywords/search terms/products to scale, Action plan with how/why/expected impact, and Monitoring checklist. Omit sections only when they truly do not apply. Use this structure for analysis questions, not count-only questions. " +
    "For relative dates such as yesterday, today, this week, last week, last 7 days, or last month, resolve the date range before querying and use explicit finite YYYY-MM-DD GAQL conditions on segments.date. " +
    `Resolve account-local relative dates using backend timezone ${relativeDates.timeZone}: today=${relativeDates.today}, yesterday=${relativeDates.yesterday}. ` +
    `For default 7-day-average comparisons, use target day ${relativeDates.yesterday} and baseline ${relativeDates.sevenDayBaselineStart} to ${relativeDates.sevenDayBaselineEnd} unless the user specifies otherwise. ` +
    "Do not silently shift 'yesterday' to an earlier date. If inherited context changes scope, state the final date range explicitly. " +
    "If account time zone matters, query customer.time_zone or use the backend account time zone supplied below, and mention the exact date range used. " +
    "For questions comparing a period to a 7-day average, define the target period explicitly. If the user does not name the target period, use yesterday as the target day and the seven complete days immediately before yesterday as the baseline. " +
    "For campaign-level 7-day-average comparisons, query all relevant campaigns with campaign.id, campaign.name, segments.date, and the requested metric over the combined target-plus-baseline date range; do not pre-limit to only top campaigns unless the user asks for top campaigns. " +
    "For 7-day-average comparisons, calculate each entity's baseline average from the seven baseline days, calculate absolute change as target value minus baseline average, calculate percent change as absolute change divided by baseline average, and rank by absolute magnitude of absolute change unless the user specifically asks for largest increase or largest decrease. " +
    "Before answering ranking questions, self-check that the row you call 'largest' has the greatest absolute change among the rows you report, and separately mention the largest increase and largest decrease when they differ. " +
    "When querying data, prefer using get_resource_metadata before search to avoid guessing fields. " +
    customerInstruction +
    `Current timestamp (UTC): ${nowIso}. Backend default account time zone: ${relativeDates.timeZone}. ` +
    `Backend date anchors: today=${relativeDates.today}, yesterday=${relativeDates.yesterday}, prior-7-days-before-yesterday=${relativeDates.sevenDayBaselineStart}..${relativeDates.sevenDayBaselineEnd}. ` +
    "If the user asks for the last 24 hours, use a finite GAQL range like DURING LAST_1_DAYS. " +
    "For change history, use resource change_event and ensure LIMIT <= 10000 and date range within last 30 days. " +
    "If the user provides a campaign id, filter change_event.change_resource_name to that campaign resource name. " +
    "Always include finite date ranges and LIMITs where required.";
  const understanding = requestPolicy(message);
  const conversationContext = formatConversationContext(conversationHistory);
  const finalQueryText = String(finalQuery || "").trim();
  const finalQueryContext = finalQueryText
    ? `Final interpreted query for tool decision:\n${finalQueryText}\n\n`
    : "";
  const userText = effectiveCustomerId
    ? `Customer ID: ${effectiveCustomerId}\n\n${conversationContext ? `${conversationContext}\n\n` : ""}${finalQueryContext}Critical query policy for this request:\n${understanding}\n\nUser request:\n${message}`
    : `${conversationContext ? `${conversationContext}\n\n` : ""}${finalQueryContext}Critical query policy for this request:\n${understanding}\n\nUser request:\n${message}`;

  const prompt = `${systemPrefix}\n\n${userText}`;
  const toolCalls = [];
  const context = {
    jobId: jobId || null,
    customerId: effectiveCustomerId || null,
    userMessage: message,
    conversationTurns: Array.isArray(conversationHistory) ? conversationHistory.length : 0,
    toolCalls,
    onPhase
  };
  const { toolCalls: _toolCalls, onPhase: _onPhase, ...logContext } = context;

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

  await onPhase?.("mcp");
  const res1 = await ai.models.generateContent({
    model: modelName(),
    contents: prompt,
    config
  });

  let text = extractText(res1);
  let res2 = null;
  if (!text || !text.trim()) {
    // Sometimes the model completes tool calls but forgets to output a final message.
    res2 = await ai.models.generateContent({
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
    finalQuery: finalQueryText || null,
    toolCalls
  };
  const finalText = includeTraceInResponse()
    ? `${text || ""}${formatExecutionTrace(debugTrace)}`
    : text;

  return { text: finalText, debugTrace, usage: modelUsage([res1, res2], "answer") };
}

export async function runGeminiUnderstanding({ message, customerId, conversationHistory = [] }) {
  const ai = createGenAiClient();
  const nowIso = new Date().toISOString();
  const relativeDates = backendRelativeDateContext();
  const effectiveCustomerId = customerId || defaultCustomerId();
  const conversationContext = formatConversationContext(conversationHistory);
  const prompt = [
    "You translate a Google Ads chat request into a short, user-readable understanding before any Google Ads API work starts.",
    "Use the recent conversation context as active session memory to resolve follow-ups, omitted date ranges, campaign/product/keyword scope, metrics, and customer/account references.",
    "For account-level metric requests (for example 'what was conversion on 21st May'), keep scope at customer/account level unless the latest user message explicitly asks for campaign/ad-group/product/keyword scope.",
    "If the message is a count or lookup request, keep the understanding short and exact. If the message asks for analysis, explain that you will analyze the data and compare it to a relevant baseline when needed.",
    "Do not call tools. Do not mention Gemini, MCP, backend, API flow, internal prompts, or implementation details.",
    "Do not answer the data question and do not invent metrics. Only restate what will be processed if the user confirms.",
    "If the user asks a clear request like 'show me yesterday campaign spend', do not ask for clarification. Frame it clearly.",
    "If context is inherited, mention the inherited item in plain language, for example: 'I will use yesterday from your previous question.' Never inherit a campaign scope that the latest user did not ask for.",
    "When the user says 'yesterday' or 'today', resolve it from the backend account-local date anchors below and mention the resolved date.",
    "If the user asks high-volume cross-campaign breakdowns (ad groups/keywords/search terms across all campaigns), ask for one campaign first. Do not suggest top 5 campaigns when the user already named a specific campaign.",
    "If the request is truly ambiguous even after using context, state the missing detail in one short sentence.",
    "Return only the confirmation text, in 2-4 short lines.",
    "",
    `Current timestamp (UTC): ${nowIso}. Backend default account time zone: ${relativeDates.timeZone}.`,
    `Resolved account-local dates: today=${relativeDates.today}, yesterday=${relativeDates.yesterday}, 7-day baseline before yesterday=${relativeDates.sevenDayBaselineStart}..${relativeDates.sevenDayBaselineEnd}.`,
    effectiveCustomerId ? `Customer ID to use: ${effectiveCustomerId}.` : "",
    conversationContext ? `${conversationContext}` : "Recent conversation context: none.",
    "",
    `Latest user request: ${message}`
  ]
    .filter(Boolean)
    .join("\n");

  await logDebugEvent("gemini.understanding_prompt_prepared", {
    customerId: effectiveCustomerId || null,
    conversationTurns: Array.isArray(conversationHistory) ? conversationHistory.length : 0,
    model: modelName(),
    prompt
  });

  const res = await ai.models.generateContent({
    model: modelName(),
    contents: prompt,
    config: {
      temperature: 0
    }
  });
  const rawText = extractText(res).trim();
  const accountScopedText = enforceAccountLevelUnderstandingText(rawText, message, effectiveCustomerId);
  const text = enforceConcreteUnderstandingText(
    accountScopedText,
    message,
    effectiveCustomerId,
    relativeDates
  );
  return {
    text:
      text ||
      `I understood your request as: ${message}\nCustomer ID: ${effectiveCustomerId || "not specified"}.`,
    customerIdUsed: effectiveCustomerId || null,
    usage: modelUsage([res], "understanding")
  };
}
