import dotenv from "dotenv";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logDebugEvent, summarizeMcpResult, debugLogFile } from "./debugLogger.js";
import { runGeminiUnderstanding, runGeminiWithMcp } from "./geminiAgent.js";
import { getMcpClient } from "./mcp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Important: when running under pm2, cwd can differ. Always load the env file
// located next to this server entrypoint.
dotenv.config({ path: path.join(__dirname, ".env") });
const chatJobsDir = path.join(__dirname, "data", "chat-jobs");
const chatSessionsDir = path.join(__dirname, "data", "chat-sessions");
const INLINE_RESPONSE_TIMEOUT_MS = 10_000;
const activeJobPromises = new Map();

function basicAuthMiddleware(req, res, next) {
  const user = process.env.BASIC_AUTH_USER || "";
  const pass = process.env.BASIC_AUTH_PASS || "";
  if (!user || !pass) return next();

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic realm=\"Google Ads Demo\"");
    return res.status(401).send("Auth required");
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = decoded.split(":");
  if (u !== user || p !== pass) return res.status(403).send("Forbidden");
  return next();
}

const app = express();
app.use(basicAuthMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "static")));

app.get("/api/healthz", (req, res) => res.json({ status: "ok" }));
app.get("/api/debug/log-path", (req, res) => res.json({ path: debugLogFile }));
app.get("/api/chat/:jobId", async (req, res) => {
  try {
    const job = await readJob(req.params.jobId);
    if (job.status === "completed" || job.status === "failed") {
      return res.json(serializeChatResponse(job));
    }
    res.json(job);
  } catch (e) {
    if (e?.code === "ENOENT") return res.status(404).json({ error: "job not found" });
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Useful for smoke tests: confirms the MCP server starts and exposes tools.
app.get("/api/mcp/tools", async (req, res) => {
  try {
    const mcp = await getMcpClient();
    const listed = await mcp.listTools();
    res.json({ tools: listed.tools ?? [] });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Free testing path (no Gemini required): call MCP tools directly.
// Body: { "name": "search", "arguments": { ... } }
app.post("/api/mcp/call", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const args = typeof req.body?.arguments === "object" && req.body.arguments ? req.body.arguments : {};
    if (!name) return res.status(400).json({ error: "name is required" });

    const mcp = await getMcpClient();
    await logDebugEvent("api.mcp_call_received", {
      toolName: name,
      toolArguments: args,
      route: "/api/mcp/call"
    });
    const out = await mcp.callTool({ name, arguments: args });
    await logDebugEvent("api.mcp_call_result", {
      toolName: name,
      toolArguments: args,
      route: "/api/mcp/call",
      result: summarizeMcpResult(out)
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post("/api/chat/understand", async (req, res) => {
  const userQueryReceivedAt = new Date().toISOString();
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const requestedCustomerId = typeof req.body?.customerId === "string" ? req.body.customerId.trim() : "";
  const customerId = resolvedCustomerId(requestedCustomerId);
  const requestedSessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const cookieSessionId = parseCookieHeader(req.headers.cookie || "").googleAdsDemoSessionId || "";
  const sessionId =
    normalizeSessionId(requestedSessionId) ||
    normalizeSessionId(cookieSessionId) ||
    crypto.randomUUID();
  if (!message) return res.status(400).json({ error: "message is required" });
  res.setHeader("Set-Cookie", sessionCookie(sessionId));

  try {
    const conversationHistory = await readSessionTurns(sessionId);
    await logDebugEvent("frontend.chat_understanding_received", {
      sessionId,
      conversationTurns: conversationHistory.length,
      message,
      requestedCustomerId,
      resolvedCustomerId: customerId,
      route: "/api/chat/understand",
      ip: req.ip,
      userAgent: req.headers["user-agent"] || ""
    });

    const understanding = await runGeminiUnderstanding({
      message,
      customerId,
      conversationHistory
    });
    const finalQueryDecidedAt = new Date().toISOString();
    const metadata = buildUnderstandingMetadata({
      message,
      finalQuery: understanding.text,
      customerIdUsed: understanding.customerIdUsed || customerId,
      sessionId,
      userQueryReceivedAt,
      finalQueryDecidedAt,
      usage: understanding.usage,
      conversationTurns: conversationHistory.length
    });

    return res.json({
      status: "ready_for_confirmation",
      sessionId,
      customerIdUsed: understanding.customerIdUsed || customerId,
      understanding: understanding.text,
      finalQueryDecidedAt,
      metadata
    });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e), sessionId });
  }
});

app.post("/api/chat", async (req, res) => {
  const userQueryReceivedAt = new Date().toISOString();
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const requestedCustomerId = typeof req.body?.customerId === "string" ? req.body.customerId.trim() : "";
  const interpretedQuery =
    typeof req.body?.interpretedQuery === "string" ? req.body.interpretedQuery.trim().slice(0, 4000) : "";
  const finalQuery = interpretedQuery || message;
  const finalQueryDecidedAt = sanitizeIsoString(req.body?.finalQueryDecidedAt) || userQueryReceivedAt;
  const interpretationMetadata =
    typeof req.body?.interpretationMetadata === "object" && req.body.interpretationMetadata
      ? req.body.interpretationMetadata
      : null;
  const customerId = resolvedCustomerId(requestedCustomerId);
  const requestedSessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const cookieSessionId = parseCookieHeader(req.headers.cookie || "").googleAdsDemoSessionId || "";
  const sessionId =
    normalizeSessionId(requestedSessionId) ||
    normalizeSessionId(cookieSessionId) ||
    crypto.randomUUID();
  if (!message) return res.status(400).json({ error: "message is required" });
  res.setHeader("Set-Cookie", sessionCookie(sessionId));

  const jobId = crypto.randomUUID();
  const conversationHistory = await readSessionTurns(sessionId);
  const job = {
    id: jobId,
    status: "queued",
    phase: "backend",
    message,
    interpretedQuery,
    finalQuery,
    finalQueryDecidedAt,
    interpretationMetadata,
    customerId,
    sessionId,
    conversationHistory,
    createdAt: userQueryReceivedAt,
    updatedAt: userQueryReceivedAt
  };

  try {
    await logDebugEvent("frontend.chat_request_received", {
      jobId,
      sessionId,
      conversationTurns: conversationHistory.length,
      message,
      requestedCustomerId,
      resolvedCustomerId: customerId,
      route: "/api/chat",
      ip: req.ip,
      userAgent: req.headers["user-agent"] || ""
    });
    await writeJob(job);
    const jobPromise = queueChatJob(job).catch((e) => {
      console.error(`Job ${jobId} failed`, e);
    });
    activeJobPromises.set(jobId, jobPromise);

    const inlineJob = await waitForJobCompletion(jobId, INLINE_RESPONSE_TIMEOUT_MS);
    if (inlineJob && (inlineJob.status === "completed" || inlineJob.status === "failed")) {
      activeJobPromises.delete(jobId);
      return res.json(serializeChatResponse(inlineJob));
    }

    res.status(202).json({
      jobId,
      sessionId,
      status: job.status,
      phase: job.phase,
      interpretedQuery: job.interpretedQuery || "",
      metadata: buildChatMetadata(job),
      pollUrl: `/api/chat/${jobId}`
    });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

function defaultCustomerId() {
  return process.env.DEFAULT_CUSTOMER_ID
    ? String(process.env.DEFAULT_CUSTOMER_ID).trim()
    : "6475421500";
}

function resolvedCustomerId(customerId) {
  return customerId || defaultCustomerId();
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

function accountCurrentYear(timeZone = backendTimeZone()) {
  return Number(accountDateFromOffset(0, timeZone).slice(0, 4));
}

function parseMonthNameToken(token = "") {
  const normalized = String(token || "").trim().toLowerCase().slice(0, 3);
  const monthMap = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };
  return monthMap[normalized] || 0;
}

function toIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return "";
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseExplicitDateRange(message, timeZone = backendTimeZone()) {
  const text = String(message || "");
  const currentYear = accountCurrentYear(timeZone);

  const normalizeOrdinals = (value) =>
    String(value || "")
      .replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
      .replace(/[,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizedText = normalizeOrdinals(text);

  const isoRangeMatch = normalizedText.match(
    /\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|thru|-)\s*(20\d{2}-\d{2}-\d{2})\b/i
  );
  if (isoRangeMatch) {
    return { dateStart: isoRangeMatch[1], dateEnd: isoRangeMatch[2], source: "explicit_range" };
  }

  const namedRangeMatch = normalizedText.match(
    /\b(\d{1,2})\s*([a-zA-Z]{3,9})(?:\s*(20\d{2}))?\s*(?:to|through|thru|-)\s*(\d{1,2})\s*([a-zA-Z]{3,9})(?:\s*(20\d{2}))?\b/i
  );
  if (namedRangeMatch) {
    const startMonth = parseMonthNameToken(namedRangeMatch[2]);
    const endMonth = parseMonthNameToken(namedRangeMatch[5]);
    const startYear = Number(namedRangeMatch[3] || namedRangeMatch[6] || currentYear);
    const endYear = Number(namedRangeMatch[6] || namedRangeMatch[3] || startYear);
    const dateStart = toIsoDate(startYear, startMonth, Number(namedRangeMatch[1]));
    const dateEnd = toIsoDate(endYear, endMonth, Number(namedRangeMatch[4]));
    if (dateStart && dateEnd) {
      return { dateStart, dateEnd, source: "explicit_range" };
    }
  }

  const monthFirstRangeMatch = normalizedText.match(
    /\b([a-zA-Z]{3,9})\s*(\d{1,2})(?:\s*(20\d{2}))?\s*(?:to|through|thru|-)\s*([a-zA-Z]{3,9})\s*(\d{1,2})(?:\s*(20\d{2}))?\b/i
  );
  if (monthFirstRangeMatch) {
    const startMonth = parseMonthNameToken(monthFirstRangeMatch[1]);
    const endMonth = parseMonthNameToken(monthFirstRangeMatch[4]);
    const startYear = Number(monthFirstRangeMatch[3] || monthFirstRangeMatch[6] || currentYear);
    const endYear = Number(monthFirstRangeMatch[6] || monthFirstRangeMatch[3] || startYear);
    const dateStart = toIsoDate(startYear, startMonth, Number(monthFirstRangeMatch[2]));
    const dateEnd = toIsoDate(endYear, endMonth, Number(monthFirstRangeMatch[5]));
    if (dateStart && dateEnd) {
      return { dateStart, dateEnd, source: "explicit_range" };
    }
  }

  return null;
}

function normalizeCampaignNameForMatch(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bads\b/g, " ads ")
    .replace(/\s+/g, " ")
    .trim();
}

function jobFilePath(jobId) {
  return path.join(chatJobsDir, `${jobId}.json`);
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return cookies;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});
}

function sessionCookie(sessionId) {
  const maxAgeSeconds = 60 * 60 * 24 * 30;
  return `googleAdsDemoSessionId=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

function normalizeSessionId(sessionId) {
  if (!sessionId) return "";
  return /^[a-zA-Z0-9_-]{8,80}$/.test(sessionId) ? sessionId : "";
}

function sessionFilePath(sessionId) {
  return path.join(chatSessionsDir, `${sessionId}.json`);
}

async function readSessionTurns(sessionId) {
  if (!sessionId) return [];
  try {
    const raw = await fs.readFile(sessionFilePath(sessionId), "utf8");
    const session = JSON.parse(raw);
    return Array.isArray(session?.turns) ? session.turns : [];
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

async function appendSessionTurns(sessionId, turns) {
  if (!sessionId || !Array.isArray(turns) || !turns.length) return;
  const existingTurns = await readSessionTurns(sessionId);
  const cleanedTurns = turns
    .map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      text: String(turn?.text || "").trim().slice(0, 12000),
      at: turn?.at || new Date().toISOString()
    }))
    .filter((turn) => turn.text);

  const nextTurns = [...existingTurns, ...cleanedTurns].slice(-20);
  await fs.mkdir(chatSessionsDir, { recursive: true });
  await fs.writeFile(
    sessionFilePath(sessionId),
    JSON.stringify(
      {
        id: sessionId,
        updatedAt: new Date().toISOString(),
        turns: nextTurns
      },
      null,
      2
    ),
    "utf8"
  );
}

async function writeJob(job) {
  await fs.mkdir(chatJobsDir, { recursive: true });
  const nextJob = { ...job, updatedAt: new Date().toISOString() };
  await fs.writeFile(jobFilePath(nextJob.id), JSON.stringify(nextJob, null, 2), "utf8");
  return nextJob;
}

async function readJob(jobId) {
  const raw = await fs.readFile(jobFilePath(jobId), "utf8");
  return JSON.parse(raw);
}

async function updateJob(jobId, patch) {
  const existing = await readJob(jobId);
  return writeJob({ ...existing, ...patch });
}

function isPausedLast24HoursQuestion(message) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("paused") &&
    normalized.includes("campaign") &&
    (normalized.includes("last 24") || normalized.includes("24 hour") || normalized.includes("last 1 day"))
  );
}

function isProductMultipleCampaignCountQuestion(message) {
  const normalized = message.toLowerCase();
  const mentionsProduct =
    normalized.includes("product") ||
    normalized.includes("products") ||
    normalized.includes("prod") ||
    normalized.includes("item");
  const mentionsCampaign = normalized.includes("campaign");
  const asksForCount =
    normalized.includes("count") ||
    normalized.includes("how many") ||
    normalized.includes("number");
  const mentionsOverlap =
    normalized.includes("different") ||
    normalized.includes("multiple") ||
    normalized.includes("more than") ||
    normalized.includes("at least") ||
    normalized.includes("2 campaign") ||
    normalized.includes("two campaign");
  return mentionsProduct && mentionsCampaign && asksForCount && mentionsOverlap;
}

function isAllCampaignScopeRequest(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("all campaign") ||
    normalized.includes("across campaign") ||
    normalized.includes("across all campaign") ||
    normalized.includes("entire campaign")
  );
}

function isHighVolumeBreakdownQuestion(message) {
  const normalized = String(message || "").toLowerCase();
  const asksDeepBreakdown =
    normalized.includes("ad group") ||
    normalized.includes("ads group") ||
    normalized.includes("ad groups") ||
    normalized.includes("ads groups") ||
    normalized.includes("adgroup") ||
    normalized.includes("keyword") ||
    normalized.includes("search term");
  const asksCountOrList =
    normalized.includes("how many") ||
    normalized.includes("list") ||
    normalized.includes("show") ||
    normalized.includes("more than") ||
    normalized.includes("cost/conversion") ||
    normalized.includes("cost per conversion");
  return asksDeepBreakdown && asksCountOrList;
}

function hasSpecificCampaignScope(message) {
  const text = String(message || "");
  const normalized = text.toLowerCase();
  const hasQuotedCampaign = /campaign\s*["“][^"”\n]{2,120}["”]/i.test(text);
  const hasCampaignId = /campaign[^0-9]{0,20}\b\d{5,}\b/i.test(text);
  const hasNamedCampaign =
    /in\s+the\s+campaign\s+[a-z0-9][a-z0-9&/().,\- ]{2,120}/i.test(text) &&
    !normalized.includes("all campaign") &&
    !normalized.includes("across campaign");
  const hasBareNamedCampaign =
    /in\s+[a-z0-9][a-z0-9&/().,\- ]{2,120}\s+(?:campaign|ads)\b/i.test(text) &&
    !normalized.includes("all campaign") &&
    !normalized.includes("across campaign");
  return hasQuotedCampaign || hasCampaignId || hasNamedCampaign || hasBareNamedCampaign;
}

function hasBroadCampaignScope(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("all campaign") ||
    normalized.includes("across campaign") ||
    normalized.includes("across all campaign") ||
    normalized.includes("entire campaign") ||
    normalized.includes("every campaign")
  );
}

function parseAdGroupCpaThresholdQuestion(message) {
  const text = String(message || "");
  const normalized = text.toLowerCase();
  const mentionsAdGroup =
    normalized.includes("ad group") ||
    normalized.includes("ads group") ||
    normalized.includes("ad groups") ||
    normalized.includes("ads groups") ||
    normalized.includes("adgroup");
  const mentionsCpa =
    normalized.includes("cost/conversion") ||
    normalized.includes("cost per conversion") ||
    normalized.includes("cpa");
  const asksCount = normalized.includes("how many") || normalized.includes("count") || normalized.includes("number");
  const mentionsLast7 = normalized.includes("last 7") || normalized.includes("7 day") || normalized.includes("7day");

  if (!(mentionsAdGroup && mentionsCpa && asksCount)) return null;

  const thresholdMatch = text.match(
    /(?:more than|greater than|above|over|exceed(?:ed|s)?|>|>=)\s*(?:inr|rs\.?|rupees?)?\s*([0-9]+(?:\.[0-9]+)?)/i
  );
  const thresholdInr = thresholdMatch ? Number(thresholdMatch[1]) : 500;
  if (!Number.isFinite(thresholdInr) || thresholdInr < 0) return null;

  const quotedCampaignAfterWord = text.match(/campaign\s*["']([^"'\n]{2,160})["']/i)?.[1]?.trim();
  const quotedCampaignBeforeWord = text.match(/(?:in|for)\s+(?:the\s+)?["']([^"'\n]{2,160})["']\s+campaign\b/i)?.[1]?.trim();
  const unquotedCampaign = text.match(/in\s+the\s+campaign\s+([^,\n.]{2,160})/i)?.[1]?.trim();
  const bareCampaignWithAds = text.match(/in\s+([a-z0-9][a-z0-9&/().,\- ]{2,160}?\s+ads)\b/i)?.[1]?.trim();
  const bareCampaignBeforeHave = text.match(/in\s+([a-z0-9][a-z0-9&/().,\- ]{2,160}?)\s+have\b/i)?.[1]?.trim();
  const campaignName =
    quotedCampaignBeforeWord ||
    quotedCampaignAfterWord ||
    unquotedCampaign ||
    bareCampaignWithAds ||
    bareCampaignBeforeHave ||
    "";
  if (!campaignName) return null;

  const explicitRange = parseExplicitDateRange(text);

  return {
    campaignName,
    thresholdInr,
    useLast7CompleteDays: mentionsLast7,
    dateStart: explicitRange?.dateStart || "",
    dateEnd: explicitRange?.dateEnd || "",
    dateSource: explicitRange?.source || ""
  };
}

function extractCampaignNamesFromText(text = "") {
  const results = [];
  const seen = new Set();
  const patterns = [
    /campaign\s*["“]([^"”\n]{3,120})["”]/gi,
    /\bIMAP[_A-Za-z0-9&/().,\- ]{4,120}\b/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = String(match[1] || match[0] || "").trim().replace(/\s+/g, " ");
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(value);
      if (results.length >= 12) return results;
    }
  }

  return results;
}

function recentCampaignCandidates(conversationHistory = [], limit = 5) {
  if (!Array.isArray(conversationHistory) || !conversationHistory.length) return [];
  const merged = conversationHistory
    .slice(-12)
    .map((turn) => String(turn?.text || ""))
    .join("\n");
  return extractCampaignNamesFromText(merged).slice(0, limit);
}

function parseMcpToolResult(toolOut) {
  if (Array.isArray(toolOut?.content)) {
    for (const item of toolOut.content) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
  }
  return toolOut;
}

async function resolveCampaignNameForAccount(customerId, requestedCampaignName, context = {}) {
  const requested = String(requestedCampaignName || "").trim();
  if (!requested) return "";

  const cid = resolvedCustomerId(customerId);
  const mcp = await getMcpClient();
  const toolRequest = {
    name: "search",
    arguments: {
      customer_id: cid,
      resource: "campaign",
      fields: ["campaign.id", "campaign.name", "campaign.status"],
      conditions: ["campaign.status = 'ENABLED'"],
      limit: 5000
    }
  };

  await logDebugEvent("server.campaign_name_resolution_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    requestedCampaignName: requested
  });
  const toolOut = await mcp.callTool(toolRequest);
  const rows = parseMcpToolResult(toolOut);
  const campaigns = Array.isArray(rows) ? rows : [];
  const requestedNormalized = normalizeCampaignNameForMatch(requested);
  const requestedTokens = requestedNormalized.split(" ").filter(Boolean);

  const scored = campaigns
    .map((row) => {
      const name = String(row?.["campaign.name"] || "").trim();
      const normalized = normalizeCampaignNameForMatch(name);
      const tokensMatched = requestedTokens.filter((token) => normalized.includes(token)).length;
      const exact = normalized === requestedNormalized;
      const contains = normalized.includes(requestedNormalized) || requestedNormalized.includes(normalized);
      return { name, normalized, exact, contains, tokensMatched };
    })
    .filter((item) => item.name && item.tokensMatched > 0)
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.contains !== b.contains) return a.contains ? -1 : 1;
      if (a.tokensMatched !== b.tokensMatched) return b.tokensMatched - a.tokensMatched;
      return a.name.length - b.name.length;
    });

  const best = scored[0];
  return best?.name || requested;
}

async function runProductMultipleCampaignFastPath(customerId, context = {}) {
  const cid = resolvedCustomerId(customerId);
  const mcp = await getMcpClient();
  const toolRequest = {
    name: "count_products_in_multiple_campaigns",
    arguments: {
      customer_id: cid,
      min_campaign_count: 2,
      campaign_status: "ENABLED",
      product_status_group: "enabled",
      sample_size: 10,
      max_campaigns: 0,
      max_concurrency: 10,
      time_budget_seconds: 0
    }
  };

  await logDebugEvent("server.fast_path_mcp_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments
  });
  const toolOut = await mcp.callTool({
    name: toolRequest.name,
    arguments: toolRequest.arguments
  });
  const result = parseMcpToolResult(toolOut);
  await logDebugEvent("server.fast_path_mcp_result", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    result: summarizeMcpResult(result)
  });

  if (!result || typeof result !== "object") {
    return {
      text: typeof result === "string" ? result : "The product campaign overlap count completed, but the result format was not recognized.",
      customerIdUsed: cid,
      mode: "fast-path",
      raw: result
    };
  }

  const count = Number(result.matching_product_count ?? 0);
  const scanned = Number(result.campaigns_scanned ?? 0);
  const available = Number(result.campaigns_available ?? 0);
  const elapsed = result.elapsed_seconds;
  const partialNote = result.is_partial
    ? `\n\nNote: This is still partial because ${result.partial_reason || "some campaign queries did not complete"}. It scanned ${scanned} out of ${available} available campaigns.`
    : "";
  const skippedNote = Array.isArray(result.campaigns_skipped) && result.campaigns_skipped.length
    ? ` ${result.campaigns_skipped.length} campaign(s) were skipped due to API errors.`
    : "";

  return {
    text: `For customer ID ${cid}, there are ${count} products running in 2 or more different enabled campaigns.\n\nCampaign scan: ${scanned} of ${available} available Shopping/Performance Max campaigns.${elapsed != null ? ` Completed in ${elapsed} seconds.` : ""}${skippedNote}${partialNote}`,
    customerIdUsed: cid,
    mode: "fast-path",
    result
  };
}

function formatInr(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "INR 0";
  return `INR ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function runTopCampaignPreviewFastPath(customerId, context = {}) {
  const cid = resolvedCustomerId(customerId);
  const dateEnd = accountDateFromOffset(-1);
  const dateStart = accountDateFromOffset(-7);
  const mcp = await getMcpClient();
  const toolRequest = {
    name: "rank_campaigns",
    arguments: {
      customer_id: cid,
      date_start: dateStart,
      date_end: dateEnd,
      metric: "performance",
      scoring_mode: "balanced",
      top_n: 5,
      status: "ENABLED"
    }
  };

  await logDebugEvent("server.fast_path_mcp_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments
  });
  const toolOut = await mcp.callTool({
    name: toolRequest.name,
    arguments: toolRequest.arguments
  });
  const result = parseMcpToolResult(toolOut);
  await logDebugEvent("server.fast_path_mcp_result", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    result: summarizeMcpResult(result)
  });

  if (!result || typeof result !== "object" || !Array.isArray(result.best)) {
    return {
      text:
        "This looks like a high-volume cross-campaign breakdown. Please pick one campaign name or ID first and I will run the detailed ad group analysis.",
      customerIdUsed: cid,
      mode: "fast-path",
      result
    };
  }

  const topRows = result.best.slice(0, 5);
  if (!topRows.length) {
    return {
      text: `I could not find enabled campaigns in ${dateStart} to ${dateEnd}. Share one campaign name or ID, or a different date range, and I will run the ad-group level breakdown.`,
      customerIdUsed: cid,
      mode: "fast-path",
      result
    };
  }

  const lines = [
    `Your request is large across all campaigns. To keep results reliable, please choose one campaign first.`,
    `Top 5 performing enabled campaigns for ${dateStart} to ${dateEnd}:`
  ];

  topRows.forEach((row, index) => {
    const conversions = Number(row?.conversions || 0);
    const cost = Number(row?.cost_micros || 0) / 1_000_000;
    lines.push(
      `${index + 1}. ${row?.campaign_name || `Campaign ${row?.campaign_id || ""}`}` +
      ` (Conversions: ${conversions.toLocaleString("en-IN", { maximumFractionDigits: 2 })}, Spend: ${formatInr(cost)})`
    );
  });

  lines.push(
    "",
    "Reply with one campaign name/ID from this list, and I will run the detailed ad-group query for that campaign."
  );

  return {
    text: lines.join("\n"),
    customerIdUsed: cid,
    mode: "fast-path",
    result: {
      date_start: dateStart,
      date_end: dateEnd,
      top_campaigns: topRows
    }
  };
}

function buildNarrowScopePrompt(job) {
  const options = recentCampaignCandidates(job?.conversationHistory || [], 5);
  const lines = [
    "This request can generate very large cross-campaign ad-group data and may fail due to limits.",
    "Please share one campaign name or campaign ID so I can run an accurate detailed breakdown."
  ];
  if (options.length) {
    lines.push("", "I can use one of these recently discussed campaigns:");
    options.forEach((name, index) => lines.push(`${index + 1}. ${name}`));
  }
  return lines.join("\n");
}

function escapeGaqlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toFiniteNumberLoose(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function formatNumber(value, maxFractionDigits = 2) {
  return Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: maxFractionDigits });
}

function parseConversionsVs7dQuery(message) {
  const normalized = String(message || "").toLowerCase();
  const mentionsConversions = normalized.includes("conversion");
  const mentions7d =
    normalized.includes("7d") ||
    normalized.includes("7-day") ||
    normalized.includes("7 day") ||
    normalized.includes("seven day");
  const mentionsCompare = normalized.includes("vs") || normalized.includes("compare") || normalized.includes("average");
  const mentionsYesterday = normalized.includes("yesterday");

  if (!mentionsConversions) return false;
  return (mentions7d && mentionsCompare) || (mentions7d && mentionsYesterday);
}

async function runAdGroupCpaThresholdFastPath(customerId, params, context = {}) {
  const cid = resolvedCustomerId(customerId);
  const thresholdInr = Number(params?.thresholdInr || 500);
  const requestedCampaignName = String(params?.campaignName || "").trim();
  const campaignName = await resolveCampaignNameForAccount(cid, requestedCampaignName, context);
  const dateEnd = String(params?.dateEnd || "").trim() || accountDateFromOffset(-1);
  const dateStart = String(params?.dateStart || "").trim() || accountDateFromOffset(-7);
  const usedExplicitRange = Boolean(params?.dateStart && params?.dateEnd);
  const mcp = await getMcpClient();

  const fields = [
    "campaign.name",
    "campaign.status",
    "ad_group.id",
    "ad_group.name",
    "ad_group.status",
    "metrics.cost_micros",
    "metrics.conversions"
  ];

  const conditions = [
    `campaign.name = '${escapeGaqlString(campaignName)}'`,
    "campaign.status = 'ENABLED'",
    "ad_group.status = 'ENABLED'",
    "metrics.conversions > 0",
    `segments.date >= '${dateStart}'`,
    `segments.date <= '${dateEnd}'`
  ];

  const toolRequest = {
    name: "search",
    arguments: {
      customer_id: cid,
      resource: "ad_group",
      fields,
      conditions,
      orderings: ["metrics.cost_micros DESC"],
      limit: 10000
    }
  };

  await logDebugEvent("server.fast_path_mcp_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments
  });
  const toolOut = await mcp.callTool({
    name: toolRequest.name,
    arguments: toolRequest.arguments
  });
  const rows = parseMcpToolResult(toolOut);
  await logDebugEvent("server.fast_path_mcp_result", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    result: summarizeMcpResult(rows)
  });

  const data = Array.isArray(rows) ? rows : [];
  const qualifying = data
    .map((row) => {
      const adGroupName = String(row?.["ad_group.name"] || "").trim();
      const conversions = toFiniteNumberLoose(row?.["metrics.conversions"]);
      const costMicros = toFiniteNumberLoose(row?.["metrics.cost_micros"]);
      if (!adGroupName || conversions <= 0 || costMicros <= 0) return null;
      const cpaInr = costMicros / 1_000_000 / conversions;
      return {
        adGroupName,
        conversions,
        cpaInr
      };
    })
    .filter((item) => item && item.cpaInr > thresholdInr)
    .sort((a, b) => b.cpaInr - a.cpaInr);

  const count = qualifying.length;
  const sample = qualifying.slice(0, 25);
  const lines = [
    `For customer ${cid}, campaign "${campaignName}", in ${usedExplicitRange ? "the requested range" : "the last 7 complete days"} (${dateStart} to ${dateEnd}), ${count} ad group(s) had cost per conversion above INR ${formatNumber(thresholdInr)}.`,
  ];

  if (!count) {
    lines.push("", "No qualifying ad groups were found in this range.");
  } else {
    lines.push("", "| Ad Group | Conversions | Cost / Conversion (INR) |", "| --- | ---: | ---: |");
    sample.forEach((item) => {
      lines.push(
        `| ${item.adGroupName} | ${formatNumber(item.conversions)} | ${formatNumber(item.cpaInr)} |`
      );
    });
    if (count > sample.length) {
      lines.push("", `Showing top ${sample.length} by highest cost per conversion.`);
    }
  }

  lines.push(
    "",
    "Formula used: cost_per_conversion = sum(metrics.cost_micros) / 1,000,000 / sum(metrics.conversions)."
  );

  return {
    text: lines.join("\n"),
    customerIdUsed: cid,
    mode: "fast-path",
    result: {
      campaign_name: campaignName,
      threshold_inr: thresholdInr,
      date_start: dateStart,
      date_end: dateEnd,
      count,
      rows: qualifying
    }
  };
}

async function runConversionsVs7dFastPath(customerId, context = {}) {
  const cid = resolvedCustomerId(customerId);
  const targetDate = accountDateFromOffset(-1);
  const baselineStart = accountDateFromOffset(-8);
  const baselineEnd = accountDateFromOffset(-2);
  const rangeStart = baselineStart;
  const rangeEnd = targetDate;
  const mcp = await getMcpClient();

  const toolRequest = {
    name: "search",
    arguments: {
      customer_id: cid,
      resource: "customer",
      fields: ["segments.date", "metrics.conversions"],
      conditions: [`segments.date >= '${rangeStart}'`, `segments.date <= '${rangeEnd}'`],
      orderings: ["segments.date ASC"],
      limit: 1000
    }
  };

  await logDebugEvent("server.fast_path_mcp_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments
  });
  const toolOut = await mcp.callTool({
    name: toolRequest.name,
    arguments: toolRequest.arguments
  });
  const rows = parseMcpToolResult(toolOut);
  await logDebugEvent("server.fast_path_mcp_result", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    result: summarizeMcpResult(rows)
  });

  const data = Array.isArray(rows) ? rows : [];
  const byDate = new Map();
  for (const row of data) {
    const date = String(row?.["segments.date"] || "").trim();
    if (!date) continue;
    byDate.set(date, toFiniteNumberLoose(row?.["metrics.conversions"]));
  }

  const targetValue = byDate.get(targetDate);
  const baselineDates = [];
  for (let offset = -8; offset <= -2; offset += 1) baselineDates.push(accountDateFromOffset(offset));
  const baselineValues = baselineDates
    .map((date) => byDate.get(date))
    .filter((value) => Number.isFinite(value));

  if (!Number.isFinite(targetValue)) {
    return {
      text: `I could not find conversion data for yesterday (${targetDate}) in this account timezone. Please verify data freshness and try a specific date range.`,
      customerIdUsed: cid,
      mode: "fast-path",
      result: {
        target_date: targetDate,
        baseline_start: baselineStart,
        baseline_end: baselineEnd,
        rows_available: data.length
      }
    };
  }

  if (!baselineValues.length) {
    return {
      text: `I found yesterday's conversions (${targetDate}: ${formatNumber(targetValue)}), but baseline data for ${baselineStart} to ${baselineEnd} is unavailable.`,
      customerIdUsed: cid,
      mode: "fast-path",
      result: {
        target_date: targetDate,
        baseline_start: baselineStart,
        baseline_end: baselineEnd,
        target_conversions: targetValue
      }
    };
  }

  const baselineAvg = baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length;
  const absoluteChange = targetValue - baselineAvg;
  const percentChange = baselineAvg !== 0 ? (absoluteChange / baselineAvg) * 100 : null;

  const lines = [
    `For customer ${cid}, conversion comparison uses explicit account-local dates (no hardcoded date):`,
    `Target day (yesterday): ${targetDate}`,
    `Baseline (previous 7 complete days): ${baselineStart} to ${baselineEnd}`,
    "",
    `Conversions on ${targetDate}: ${formatNumber(targetValue)}`,
    `Average daily conversions (${baselineStart} to ${baselineEnd}): ${formatNumber(baselineAvg)}`,
    `Absolute change: ${absoluteChange >= 0 ? "+" : ""}${formatNumber(absoluteChange)}`,
    `Percent change: ${percentChange == null ? "N/A" : `${percentChange >= 0 ? "+" : ""}${percentChange.toFixed(2)}%`}`
  ];

  return {
    text: lines.join("\n"),
    customerIdUsed: cid,
    mode: "fast-path",
    result: {
      target_date: targetDate,
      baseline_start: baselineStart,
      baseline_end: baselineEnd,
      target_conversions: targetValue,
      baseline_average: baselineAvg,
      absolute_change: absoluteChange,
      percent_change: percentChange
    }
  };
}

async function runPausedCampaignFastPath(customerId, context = {}) {
  const cid = resolvedCustomerId(customerId);
  if (!cid) {
    throw new Error("A customer id is required for this account query. Pass customerId or set DEFAULT_CUSTOMER_ID.");
  }

  const mcp = await getMcpClient();

  const toolRequest = {
    name: "search",
    arguments: {
      customer_id: cid,
      resource: "change_event",
      fields: [
        "change_event.change_date_time",
        "change_event.user_email",
        "change_event.change_resource_name",
        "change_event.change_resource_type",
        "change_event.resource_change_operation",
        "change_event.changed_fields"
      ],
      conditions: [
        "change_event.change_date_time DURING LAST_1_DAYS",
        "change_event.change_resource_type = 'CAMPAIGN'",
        "change_event.resource_change_operation = 'UPDATE'"
      ],
      orderings: ["change_event.change_date_time DESC"],
      limit: 2000
    }
  };

  await logDebugEvent("server.fast_path_mcp_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments
  });
  const toolOut = await mcp.callTool({
    name: toolRequest.name,
    arguments: toolRequest.arguments
  });
  await logDebugEvent("server.fast_path_mcp_result", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    result: summarizeMcpResult(toolOut)
  });

  const rows = Array.isArray(toolOut?.content) ? toolOut.content : toolOut;
  const arr = Array.isArray(rows) ? rows : [];

  const statusEvents = arr.filter((r) => {
    const cf = r?.["change_event.changed_fields"] ?? r?.change_event?.changed_fields ?? r?.changed_fields;
    const s = Array.isArray(cf) ? cf.join(",") : String(cf ?? "");
    return s.toLowerCase().includes("status");
  });

  const campaignIds = new Set(
    statusEvents
      .map((r) => String(r?.["change_event.change_resource_name"] ?? r?.change_event?.change_resource_name ?? ""))
      .map((rn) => {
        const m = rn.match(/\/campaigns\/(\d+)$/);
        return m ? m[1] : "";
      })
      .filter(Boolean)
  );

  const lines = [
    `In the last 24 hours (DURING LAST_1_DAYS), I found ${statusEvents.length} campaign change event(s) where status may have changed (customer id: ${cid}).`,
    campaignIds.size ? `Campaign IDs involved: ${Array.from(campaignIds).slice(0, 50).join(", ")}.` : "No campaign IDs could be extracted.",
    "",
    "Top events (most recent first):",
    ...statusEvents.slice(0, 20).map((r) => {
      const dt = r?.["change_event.change_date_time"] ?? "";
      const email = r?.["change_event.user_email"] ?? "";
      const rn = r?.["change_event.change_resource_name"] ?? "";
      const fields = r?.["change_event.changed_fields"] ?? "";
      return `- ${dt} | ${email || "unknown"} | ${rn} | changed_fields=${Array.isArray(fields) ? fields.join(",") : String(fields)}`;
    }),
    "",
    "If you need only 'paused' (and not any status change), we can refine this once we confirm which change_event fields expose old/new status in your account."
  ];

  return { text: lines.join("\n"), customerIdUsed: cid, mode: "fast-path" };
}

async function runChatJob(job) {
  const context = {
    jobId: job.id,
    customerId: job.customerId,
    sessionId: job.sessionId,
    userMessage: job.message
  };

  if (parseConversionsVs7dQuery(job.message)) {
    await updateJob(job.id, { phase: "ads" });
    const out = await runConversionsVs7dFastPath(job.customerId, context);
    return { ...out, interpretedQuery: job.interpretedQuery || "" };
  }

  const adGroupCpaQuestion = parseAdGroupCpaThresholdQuestion(job.message);
  if (adGroupCpaQuestion) {
    await updateJob(job.id, { phase: "ads" });
    const out = await runAdGroupCpaThresholdFastPath(job.customerId, adGroupCpaQuestion, context);
    return { ...out, interpretedQuery: job.interpretedQuery || "" };
  }

  if (isPausedLast24HoursQuestion(job.message)) {
    await updateJob(job.id, { phase: "ads" });
    const out = await runPausedCampaignFastPath(job.customerId, context);
    return { ...out, interpretedQuery: job.interpretedQuery || "" };
  }

  if (isProductMultipleCampaignCountQuestion(job.message)) {
    await updateJob(job.id, { phase: "ads" });
    const out = await runProductMultipleCampaignFastPath(job.customerId, context);
    return { ...out, interpretedQuery: job.interpretedQuery || "" };
  }

  const out = await runGeminiWithMcp({
    message: job.message,
    finalQuery: job.finalQuery || job.interpretedQuery || "",
    customerId: job.customerId,
    jobId: job.id,
    conversationHistory: job.conversationHistory || [],
    onPhase: async (phase) => updateJob(job.id, { phase })
  });
  return {
    ...out,
    interpretedQuery: job.interpretedQuery || "",
    customerIdUsed: resolvedCustomerId(job.customerId) || null,
    mode: "gemini"
  };
}

async function queueChatJob(job) {
  await updateJob(job.id, { status: "running", phase: "backend", startedAt: new Date().toISOString() });
  try {
    const result = await runChatJob(job);
    await updateJob(job.id, {
      status: "completed",
      phase: "return",
      completedAt: new Date().toISOString(),
      result
    });
    await appendSessionTurns(job.sessionId, [
      { role: "user", text: job.message, at: job.createdAt },
      { role: "assistant", text: result?.text || "", at: new Date().toISOString() }
    ]);
    await logDebugEvent("chat_job.completed", {
      jobId: job.id,
      sessionId: job.sessionId,
      customerId: job.customerId,
      mode: result?.mode || null,
      textPreview: String(result?.text || "").slice(0, 4000)
    });
  } catch (e) {
    const publicMessage = publicErrorMessage(e, job);
    await updateJob(job.id, {
      status: "failed",
      phase: "error",
      completedAt: new Date().toISOString(),
      error: publicMessage
    });
    await appendSessionTurns(job.sessionId, [
      { role: "user", text: job.message, at: job.createdAt },
      { role: "assistant", text: `Request failed: ${publicMessage}`, at: new Date().toISOString() }
    ]);
    await logDebugEvent("chat_job.failed", {
      jobId: job.id,
      sessionId: job.sessionId,
      customerId: job.customerId,
      error: publicMessage
    });
  } finally {
    activeJobPromises.delete(job.id);
  }
}

function publicErrorMessage(error, job = null) {
  const message = error?.message ?? String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("resource exhausted") ||
    lower.includes("resource_exhausted") ||
    lower.includes("code\":429") ||
    lower.includes("quota") ||
    lower.includes("rate limit")
  ) {
    const campaigns = recentCampaignCandidates(job?.conversationHistory || [], 5);
    const campaignLine = campaigns.length
      ? ` Recently discussed campaigns: ${campaigns.join(", ")}.`
      : "";
    return [
      "The request hit a temporary processing limit (429 / RESOURCE_EXHAUSTED).",
      "Please narrow scope to one campaign and a finite date range, or ask for top 5 performing campaigns first.",
      "Example: 'For campaign <name>, show ad groups with cost per conversion > 500 in last 7 days.'",
      campaignLine
    ].join(" ").trim();
  }
  if (
    lower.includes("input token count") ||
    lower.includes("maximum number of tokens") ||
    lower.includes("exceeds the maximum")
  ) {
    return [
      "The request produced too much raw data for Gemini to process safely.",
      "For count-style questions, ask for a count/summary rather than all rows. This backend now includes a count_rows tool so product/feed counts can be answered without loading every product row.",
      "If you still see this after redeploy, narrow the request by date, resource, status, or ask for a sample plus total count."
    ].join(" ");
  }
  return message;
}

function metadataProjectKey() {
  return process.env.RESPONSE_METADATA_PROJECT || process.env.PROJECT_NAME || "google-ads-mcp";
}

function sanitizeIsoString(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function durationMs(startIso, endIso) {
  const start = new Date(startIso || "").getTime();
  const end = new Date(endIso || "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function totalTokensConsumed(usages) {
  return usages.reduce((sum, usage) => {
    const value = Number(usage?.tokens?.total);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function totalEstimatedCostUsd(usages) {
  let sawValue = false;
  const total = usages.reduce((sum, usage) => {
    const value = Number(usage?.cost?.estimatedUsd);
    if (!Number.isFinite(value)) return sum;
    sawValue = true;
    return sum + value;
  }, 0);
  return sawValue ? Number(total.toFixed(8)) : null;
}

function usageFromSimpleMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  return {
    model: metadata.modelName || null,
    tokens: {
      total: Number(metadata.totalTokensConsumed || 0)
    },
    cost: {
      estimatedUsd:
        metadata.estimatedCostUsd == null || !Number.isFinite(Number(metadata.estimatedCostUsd))
          ? null
          : Number(metadata.estimatedCostUsd)
    }
  };
}

function buildUnderstandingMetadata({
  message,
  finalQuery,
  userQueryReceivedAt,
  finalQueryDecidedAt,
  usage
}) {
  return {
    totalTokensConsumed: Number(usage?.tokens?.total || 0),
    modelName: usage?.model || null,
    projectName: metadataProjectKey(),
    userQuery: message,
    finalQuery,
    estimatedCostUsd: usage?.cost?.estimatedUsd ?? null,
    durationUserInputToFinalQueryMs: durationMs(userQueryReceivedAt, finalQueryDecidedAt),
    durationFinalQueryToOutputMs: null
  };
}

function buildChatMetadata(job, result = null) {
  const outputDeliveredAt = job.completedAt || (job.status === "completed" || job.status === "failed" ? job.updatedAt : null);
  const interpretationUsage = usageFromSimpleMetadata(job.interpretationMetadata);
  const usages = [interpretationUsage, result?.usage].filter(Boolean);
  return {
    totalTokensConsumed: totalTokensConsumed(usages),
    modelName: result?.usage?.model || interpretationUsage?.model || null,
    projectName: metadataProjectKey(),
    userQuery: job.message || "",
    finalQuery: job.finalQuery || job.interpretedQuery || job.message || "",
    estimatedCostUsd: totalEstimatedCostUsd(usages),
    durationUserInputToFinalQueryMs: durationMs(job.createdAt, job.finalQueryDecidedAt || job.createdAt),
    durationFinalQueryToOutputMs: durationMs(job.finalQueryDecidedAt || job.createdAt, outputDeliveredAt)
  };
}

function publicResult(result) {
  if (!result || typeof result !== "object") return result || null;
  const { usage, metadata, ...rest } = result;
  return rest;
}

function serializeChatResponse(job) {
  if (job.status === "completed") {
    const metadata = buildChatMetadata(job, job.result);
    return {
      status: "completed",
      text: job.result?.text || "",
      result: publicResult(job.result),
      interpretedQuery: job.result?.interpretedQuery || job.interpretedQuery || "",
      metadata,
      customerIdUsed: job.result?.customerIdUsed || null,
      mode: job.result?.mode || null,
      sessionId: job.sessionId || null,
      jobId: job.id,
      phase: job.phase || "return"
    };
  }

  if (job.status === "failed") {
    const metadata = buildChatMetadata(job);
    return {
      status: "failed",
      error: job.error || "Unknown error",
      interpretedQuery: job.interpretedQuery || "",
      metadata,
      sessionId: job.sessionId || null,
      jobId: job.id,
      phase: job.phase || "error"
    };
  }

  return job;
}

async function waitForJobCompletion(jobId, timeoutMs) {
  const jobPromise = activeJobPromises.get(jobId);
  if (!jobPromise) return null;

  await Promise.race([
    jobPromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);

  try {
    return await readJob(jobId);
  } catch {
    return null;
  }
}

const port = Number(process.env.PORT || 3100);
app.listen(port, "0.0.0.0", () => {
  console.log(`Demo UI listening on http://0.0.0.0:${port}`);
});
