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

function scoreCampaignNameMatch(requestedCampaignName, candidateName) {
  const requestedNormalized = normalizeCampaignNameForMatch(requestedCampaignName);
  const candidateNormalized = normalizeCampaignNameForMatch(candidateName);
  const requestedTokens = requestedNormalized.split(" ").filter(Boolean);
  const tokensMatched = requestedTokens.filter((token) => candidateNormalized.includes(token)).length;
  const exact = candidateNormalized === requestedNormalized;
  const contains =
    candidateNormalized.includes(requestedNormalized) || requestedNormalized.includes(candidateNormalized);
  const requiredTokenMatches = Math.max(1, Math.ceil(requestedTokens.length * 0.75));
  const acceptable = exact || contains || tokensMatched >= requiredTokenMatches;

  return {
    exact,
    contains,
    tokensMatched,
    acceptable,
    nameLength: String(candidateName || "").length
  };
}

async function resolveCampaignCandidatesForAccount(customerId, requestedCampaignName, context = {}) {
  const requested = String(requestedCampaignName || "").trim();
  if (!requested) return [];

  const cid = resolvedCustomerId(customerId);
  const mcp = await getMcpClient();
  const toolRequest = {
    name: "search",
    arguments: {
      customer_id: cid,
      resource: "campaign",
      fields: ["campaign.id", "campaign.name", "campaign.status"],
      conditions: [],
      limit: 10000
    }
  };

  await logDebugEvent("server.campaign_resolution_call", {
    ...context,
    toolName: toolRequest.name,
    toolArguments: toolRequest.arguments,
    requestedCampaignName: requested
  });
  const toolOut = await mcp.callTool(toolRequest);
  const rows = parseMcpToolResult(toolOut);
  const campaigns = Array.isArray(rows) ? rows : [];

  const scored = campaigns
    .map((row) => {
      const id = String(row?.["campaign.id"] || "").trim();
      const name = String(row?.["campaign.name"] || "").trim();
      const status = String(row?.["campaign.status"] || "").trim();
      const match = scoreCampaignNameMatch(requested, name);
      return { id, name, status, ...match };
    })
    .filter((item) => item.id && item.name && item.acceptable)
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.contains !== b.contains) return a.contains ? -1 : 1;
      if (a.status !== b.status) {
        if (a.status === "ENABLED") return -1;
        if (b.status === "ENABLED") return 1;
      }
      if (a.tokensMatched !== b.tokensMatched) return b.tokensMatched - a.tokensMatched;
      return a.nameLength - b.nameLength;
    });

  const candidates = scored.slice(0, 8).map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    match: {
      exact: item.exact,
      contains: item.contains,
      tokensMatched: item.tokensMatched
    }
  }));
  const best = candidates[0] || null;
  await logDebugEvent("server.campaign_resolution_result", {
    ...context,
    requestedCampaignName: requested,
    campaignCount: campaigns.length,
    selectedCampaignId: best?.id || null,
    selectedCampaignName: best?.name || null,
    selectedCampaignStatus: best?.status || null,
    selectedMatch: best?.match || null,
    candidates
  });

  return candidates;
}

async function resolveCampaignForAccount(customerId, requestedCampaignName, context = {}) {
  const candidates = await resolveCampaignCandidatesForAccount(customerId, requestedCampaignName, context);
  return candidates[0] || null;
}

async function resolveCampaignNameForAccount(customerId, requestedCampaignName, context = {}) {
  const campaign = await resolveCampaignForAccount(customerId, requestedCampaignName, context);
  return campaign?.name || String(requestedCampaignName || "").trim();
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

function isMetricDipRootCauseQuestion(message) {
  const normalized = String(message || "").toLowerCase();
  const hasRootCauseIntent =
    normalized.includes("why") ||
    normalized.includes("reason") ||
    normalized.includes("cause") ||
    normalized.includes("what led") ||
    normalized.includes("what caused");
  const hasDipLanguage =
    normalized.includes("dip") ||
    normalized.includes("decline") ||
    normalized.includes("drop") ||
    normalized.includes("down") ||
    normalized.includes("decrease") ||
    normalized.includes("fell") ||
    normalized.includes("fall");
  const hasMetricLanguage =
    normalized.includes("metric") ||
    normalized.includes("metrics") ||
    normalized.includes("conversion") ||
    normalized.includes("click") ||
    normalized.includes("impression") ||
    normalized.includes("spend") ||
    normalized.includes("traffic") ||
    normalized.includes("performance");
  return hasRootCauseIntent && hasDipLanguage && hasMetricLanguage;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function changeEventFieldText(fields) {
  if (Array.isArray(fields)) return fields.join(" ").toLowerCase();
  return String(fields || "").toLowerCase();
}

function summarizeChangeEventSignals(rows = []) {
  const events = [];
  const counts = {
    status: 0,
    budget: 0,
    bidding: 0,
    target_roas: 0,
    target_cpa: 0,
    keywords: 0,
    ad_group: 0,
    asset: 0,
    product: 0,
    policy: 0,
    verification: 0,
    other: 0
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const changedFields = row?.["change_event.changed_fields"] ?? row?.change_event?.changed_fields ?? row?.changed_fields ?? "";
    const fieldText = changeEventFieldText(changedFields);
    const changeDateTime = String(row?.["change_event.change_date_time"] ?? row?.change_event?.change_date_time ?? "").trim();
    const userEmail = String(row?.["change_event.user_email"] ?? row?.change_event?.user_email ?? "").trim();
    const resourceName = String(row?.["change_event.change_resource_name"] ?? row?.change_event?.change_resource_name ?? "").trim();
    const resourceType = String(row?.["change_event.change_resource_type"] ?? row?.change_event?.change_resource_type ?? "").trim();

    const labels = [];
    if (fieldText.includes("status")) {
      counts.status += 1;
      labels.push("status");
    }
    if (fieldText.includes("budget")) {
      counts.budget += 1;
      labels.push("budget");
    }
    if (fieldText.includes("bid") || fieldText.includes("bidding")) {
      counts.bidding += 1;
      labels.push("bid/bidding");
    }
    if (fieldText.includes("target_roas") || fieldText.includes("roas")) {
      counts.target_roas += 1;
      labels.push("target ROAS");
    }
    if (fieldText.includes("target_cpa") || fieldText.includes("cpa")) {
      counts.target_cpa += 1;
      labels.push("target CPA");
    }
    if (fieldText.includes("keyword") || fieldText.includes("search_term")) {
      counts.keywords += 1;
      labels.push("keyword/search term");
    }
    if (fieldText.includes("ad_group")) {
      counts.ad_group += 1;
      labels.push("ad group");
    }
    if (fieldText.includes("asset")) {
      counts.asset += 1;
      labels.push("asset");
    }
    if (fieldText.includes("product") || fieldText.includes("shopping_product")) {
      counts.product += 1;
      labels.push("product");
    }
    if (fieldText.includes("policy")) {
      counts.policy += 1;
      labels.push("policy");
    }
    if (fieldText.includes("verification")) {
      counts.verification += 1;
      labels.push("verification");
    }
    if (!labels.length) counts.other += 1;

    const labelText = labels.length ? labels.join(", ") : "other";
    events.push({
      changeDateTime,
      userEmail,
      resourceName,
      resourceType,
      labelText
    });
  }

  return { counts, events };
}

function toSharePercent(value) {
  const numeric = toFiniteNumberLoose(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric <= 1 ? numeric * 100 : numeric;
}

async function runAdGroupCpaThresholdFastPath(customerId, params, context = {}) {
  const cid = resolvedCustomerId(customerId);
  const thresholdInr = Number(params?.thresholdInr || 500);
  const requestedCampaignName = String(params?.campaignName || "").trim();
  const resolvedCampaignCandidates = await resolveCampaignCandidatesForAccount(cid, requestedCampaignName, context);
  const campaignScopes = resolvedCampaignCandidates.length
    ? resolvedCampaignCandidates.slice(0, 5)
    : [{ id: "", name: requestedCampaignName, status: "", match: null }];
  const dateEnd = String(params?.dateEnd || "").trim() || accountDateFromOffset(-1);
  const dateStart = String(params?.dateStart || "").trim() || accountDateFromOffset(-7);
  const usedExplicitRange = Boolean(params?.dateStart && params?.dateEnd);
  const mcp = await getMcpClient();

  const fields = [
    "campaign.id",
    "campaign.name",
    "campaign.status",
    "ad_group.id",
    "ad_group.name",
    "ad_group.status",
    "metrics.cost_micros",
    "metrics.conversions"
  ];

  const attempts = [];
  for (const campaignScope of campaignScopes) {
    const scopeName = campaignScope?.name || requestedCampaignName;
    const conditions = [
      campaignScope?.id
        ? `campaign.id = ${campaignScope.id}`
        : `campaign.name = '${escapeGaqlString(scopeName)}'`,
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
      toolArguments: toolRequest.arguments,
      campaignScope
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
      campaignScope,
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
        if (!Number.isFinite(cpaInr) || cpaInr <= thresholdInr) return null;
        return {
          adGroupName,
          conversions,
          cpaInr
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.cpaInr - a.cpaInr);

    attempts.push({
      campaign: campaignScope,
      rowsFetched: data.length,
      qualifying
    });
  }

  const chosenAttempt =
    attempts.find((attempt) => attempt.qualifying.length > 0) ||
    attempts.find((attempt) => attempt.rowsFetched > 0) ||
    attempts[0] ||
    { campaign: { id: "", name: requestedCampaignName, status: "" }, rowsFetched: 0, qualifying: [] };
  const resolvedCampaign = chosenAttempt.campaign;
  const campaignName = resolvedCampaign?.name || requestedCampaignName;
  const qualifying = chosenAttempt.qualifying;

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
      requested_campaign_name: requestedCampaignName,
      resolved_campaign_id: resolvedCampaign?.id || null,
      resolved_campaign_name: resolvedCampaign?.name || null,
      resolved_campaign_status: resolvedCampaign?.status || null,
      campaign_name: campaignName,
      threshold_inr: thresholdInr,
      date_start: dateStart,
      date_end: dateEnd,
      rows_fetched: chosenAttempt.rowsFetched,
      ad_groups_scanned: chosenAttempt.rowsFetched,
      campaign_attempts: attempts.map((attempt) => ({
        campaign_id: attempt.campaign?.id || null,
        campaign_name: attempt.campaign?.name || null,
        campaign_status: attempt.campaign?.status || null,
        rows_fetched: attempt.rowsFetched,
        qualifying_count: attempt.qualifying.length
      })),
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

async function runMetricDipRootCauseFastPath(customerId, context = {}) {
  const cid = resolvedCustomerId(customerId);
  const targetDate = accountDateFromOffset(-1);
  const baselineStart = accountDateFromOffset(-8);
  const baselineEnd = accountDateFromOffset(-2);
  const analysisStart = accountDateFromOffset(-30);
  const analysisEnd = targetDate;
  const metricFields = ["metrics.clicks", "metrics.impressions", "metrics.cost_micros", "metrics.conversions"];
  const mcp = await getMcpClient();

  const callParsedTool = async (name, arguments_) => {
    const toolRequest = { name, arguments: arguments_ };
    await logDebugEvent("server.fast_path_mcp_call", {
      ...context,
      toolName: toolRequest.name,
      toolArguments: toolRequest.arguments
    });
    const toolOut = await mcp.callTool(toolRequest);
    const parsed = parseMcpToolResult(toolOut);
    await logDebugEvent("server.fast_path_mcp_result", {
      ...context,
      toolName: toolRequest.name,
      toolArguments: toolRequest.arguments,
      result: summarizeMcpResult(parsed)
    });
    return parsed;
  };

  const fetchCampaignImpressionShareSnapshot = async () => {
    const fieldSets = [
      [
        "campaign.id",
        "campaign.name",
        "campaign.status",
        "metrics.search_impression_share",
        "metrics.search_budget_lost_impression_share",
        "metrics.search_rank_lost_impression_share",
        "metrics.search_top_impression_share",
        "metrics.search_absolute_top_impression_share",
        "metrics.clicks",
        "metrics.impressions",
        "metrics.cost_micros",
        "metrics.conversions"
      ],
      [
        "campaign.id",
        "campaign.name",
        "campaign.status",
        "metrics.search_impression_share",
        "metrics.search_budget_lost_impression_share",
        "metrics.search_rank_lost_impression_share",
        "metrics.top_impression_percentage",
        "metrics.absolute_top_impression_percentage",
        "metrics.clicks",
        "metrics.impressions",
        "metrics.cost_micros",
        "metrics.conversions"
      ]
    ];
    let lastError = null;

    for (const fields of fieldSets) {
      try {
        const rows = await callParsedTool("search", {
          customer_id: cid,
          resource: "campaign",
          fields,
          conditions: [`segments.date = '${targetDate}'`, "campaign.status = 'ENABLED'"],
          orderings: ["metrics.impressions DESC"],
          limit: 1000
        });
        const items = (Array.isArray(rows) ? rows : [])
          .map((row) => {
            const budgetLostShare = toSharePercent(
              row?.["metrics.search_budget_lost_impression_share"] ??
                row?.["metrics.search_budget_lost_impr. share"] ??
                row?.["metrics.search_budget_lost_impr_share"]
            );
            const rankLostShare = toSharePercent(row?.["metrics.search_rank_lost_impression_share"]);
            const searchShare = toSharePercent(
              row?.["metrics.search_impression_share"] ??
                row?.["metrics.search_top_impression_share"] ??
                row?.["metrics.top_impression_percentage"]
            );
            const absoluteTopShare = toSharePercent(
              row?.["metrics.search_absolute_top_impression_share"] ??
                row?.["metrics.absolute_top_impression_percentage"]
            );
            const clicks = toFiniteNumberLoose(row?.["metrics.clicks"]);
            const impressions = toFiniteNumberLoose(row?.["metrics.impressions"]);
            const cost = toFiniteNumberLoose(row?.["metrics.cost_micros"]) / 1_000_000;
            const conversions = toFiniteNumberLoose(row?.["metrics.conversions"]);
            const priorityScore = (budgetLostShare || 0) + (rankLostShare || 0);
            return {
              campaignId: String(row?.["campaign.id"] || "").trim(),
              campaignName: String(row?.["campaign.name"] || "").trim(),
              campaignStatus: String(row?.["campaign.status"] || "").trim(),
              searchShare,
              budgetLostShare,
              rankLostShare,
              absoluteTopShare,
              clicks,
              impressions,
              cost,
              conversions,
              priorityScore
            };
          })
          .filter((item) => item.campaignId);

        if (!items.length) continue;
        const summary = items.reduce(
          (accumulator, item) => {
            accumulator.rowCount += 1;
            if (Number.isFinite(item.searchShare)) accumulator.maxSearchShare = Math.max(accumulator.maxSearchShare, item.searchShare);
            if (Number.isFinite(item.budgetLostShare))
              accumulator.maxBudgetLostShare = Math.max(accumulator.maxBudgetLostShare, item.budgetLostShare);
            if (Number.isFinite(item.rankLostShare))
              accumulator.maxRankLostShare = Math.max(accumulator.maxRankLostShare, item.rankLostShare);
            if (Number.isFinite(item.absoluteTopShare))
              accumulator.maxAbsoluteTopShare = Math.max(accumulator.maxAbsoluteTopShare, item.absoluteTopShare);
            return accumulator;
          },
          {
            rowCount: 0,
            maxSearchShare: null,
            maxBudgetLostShare: null,
            maxRankLostShare: null,
            maxAbsoluteTopShare: null
          }
        );

        return {
          available: true,
          fields,
          summary,
          items: items.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 5)
        };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      available: false,
      error: lastError?.message || null,
      fields: [],
      summary: null,
      items: []
    };
  };

  const [targetSummaryRaw, baselineSummaryRaw, conversionsCompareRaw, clicksCompareRaw, impressionsCompareRaw, costCompareRaw, diagnosisRaw, changeEventsRaw] =
    await Promise.all([
      callParsedTool("account_metric_summary", {
        customer_id: cid,
        date_start: targetDate,
        date_end: targetDate,
        metrics: metricFields
      }),
      callParsedTool("account_metric_summary", {
        customer_id: cid,
        date_start: baselineStart,
        date_end: baselineEnd,
        metrics: metricFields
      }),
      callParsedTool("compare_campaigns_to_7day_average", {
        customer_id: cid,
        metric: "conversions",
        target_date: targetDate,
        top_n: 8,
        status: "ENABLED"
      }),
      callParsedTool("compare_campaigns_to_7day_average", {
        customer_id: cid,
        metric: "clicks",
        target_date: targetDate,
        top_n: 8,
        status: "ENABLED"
      }),
      callParsedTool("compare_campaigns_to_7day_average", {
        customer_id: cid,
        metric: "impressions",
        target_date: targetDate,
        top_n: 8,
        status: "ENABLED"
      }),
      callParsedTool("compare_campaigns_to_7day_average", {
        customer_id: cid,
        metric: "cost",
        target_date: targetDate,
        top_n: 8,
        status: "ENABLED"
      }),
      callParsedTool("diagnose_campaign_period", {
        customer_id: cid,
        date_start: analysisStart,
        date_end: analysisEnd,
        status: "ENABLED",
        top_n: 5
      }),
      callParsedTool("search", {
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
          "change_event.change_date_time DURING LAST_30_DAYS",
          "change_event.resource_change_operation = 'UPDATE'"
        ],
        orderings: ["change_event.change_date_time DESC"],
        limit: 2000
      })
    ]);

  const targetSummary = targetSummaryRaw?.metrics || {};
  const baselineSummary = baselineSummaryRaw?.metrics || {};

  const accountTotals = {
    target: {
      clicks: toFiniteNumberLoose(targetSummary["metrics.clicks"]),
      impressions: toFiniteNumberLoose(targetSummary["metrics.impressions"]),
      cost: toFiniteNumberLoose(targetSummary.cost),
      conversions: toFiniteNumberLoose(targetSummary["metrics.conversions"])
    },
    baselineDaily: {
      clicks: toFiniteNumberLoose(baselineSummary["metrics.clicks"]) / 7,
      impressions: toFiniteNumberLoose(baselineSummary["metrics.impressions"]) / 7,
      cost: toFiniteNumberLoose(baselineSummary.cost) / 7,
      conversions: toFiniteNumberLoose(baselineSummary["metrics.conversions"]) / 7
    }
  };

  const accountDelta = {
    clicks: accountTotals.target.clicks - accountTotals.baselineDaily.clicks,
    impressions: accountTotals.target.impressions - accountTotals.baselineDaily.impressions,
    cost: accountTotals.target.cost - accountTotals.baselineDaily.cost,
    conversions: accountTotals.target.conversions - accountTotals.baselineDaily.conversions
  };

  const accountPercentChange = {
    clicks: accountTotals.baselineDaily.clicks
      ? (accountDelta.clicks / accountTotals.baselineDaily.clicks) * 100
      : null,
    impressions: accountTotals.baselineDaily.impressions
      ? (accountDelta.impressions / accountTotals.baselineDaily.impressions) * 100
      : null,
    cost: accountTotals.baselineDaily.cost ? (accountDelta.cost / accountTotals.baselineDaily.cost) * 100 : null,
    conversions: accountTotals.baselineDaily.conversions
      ? (accountDelta.conversions / accountTotals.baselineDaily.conversions) * 100
      : null
  };

  const targetConversionRate =
    accountTotals.target.clicks > 0 ? accountTotals.target.conversions / accountTotals.target.clicks : null;
  const baselineConversionRate =
    accountTotals.baselineDaily.clicks > 0
      ? accountTotals.baselineDaily.conversions / accountTotals.baselineDaily.clicks
      : null;
  const conversionRateChange =
    baselineConversionRate && baselineConversionRate > 0
      ? ((targetConversionRate - baselineConversionRate) / baselineConversionRate) * 100
      : null;

  const impressionShareSnapshot = await fetchCampaignImpressionShareSnapshot();

  const compareRawByMetric = {
    conversions: conversionsCompareRaw,
    clicks: clicksCompareRaw,
    impressions: impressionsCompareRaw,
    cost: costCompareRaw
  };
  const campaignMap = new Map();
  const positiveCampaignMap = new Map();
  for (const [metricName, compareRaw] of Object.entries(compareRawByMetric)) {
    const rows = Array.isArray(compareRaw?.largest_decreases) ? compareRaw.largest_decreases : [];
    for (const row of rows) {
      const campaignId = String(row?.campaign_id || "").trim();
      if (!campaignId) continue;
      const campaignName = String(row?.campaign_name || "").trim();
      const absoluteChange = toFiniteNumberLoose(row?.absolute_change);
      if (absoluteChange >= 0) continue;
      const percentChange = Number.isFinite(Number(row?.percent_change)) ? Number(row.percent_change) : null;
      const entry = campaignMap.get(campaignId) || {
        campaignId,
        campaignName,
        campaignStatus: String(row?.campaign_status || "").trim(),
        metrics: {},
        score: 0
      };
      if (campaignName && !entry.campaignName) entry.campaignName = campaignName;
      if (row?.campaign_status && !entry.campaignStatus) entry.campaignStatus = String(row.campaign_status).trim();
      entry.metrics[metricName] = {
        targetValue: toFiniteNumberLoose(row?.target_value),
        baselineAverage: toFiniteNumberLoose(row?.baseline_average),
        absoluteChange,
        percentChange
      };
      if (absoluteChange < 0) {
        entry.score += Math.abs(percentChange ?? absoluteChange);
      }
      campaignMap.set(campaignId, entry);
    }

    const gainRows = Array.isArray(compareRaw?.largest_increases) ? compareRaw.largest_increases : [];
    for (const row of gainRows) {
      const campaignId = String(row?.campaign_id || "").trim();
      if (!campaignId) continue;
      const campaignName = String(row?.campaign_name || "").trim();
      const absoluteChange = toFiniteNumberLoose(row?.absolute_change);
      if (absoluteChange <= 0) continue;
      const percentChange = Number.isFinite(Number(row?.percent_change)) ? Number(row.percent_change) : null;
      const entry = positiveCampaignMap.get(campaignId) || {
        campaignId,
        campaignName,
        campaignStatus: String(row?.campaign_status || "").trim(),
        metrics: {},
        score: 0
      };
      if (campaignName && !entry.campaignName) entry.campaignName = campaignName;
      if (row?.campaign_status && !entry.campaignStatus) entry.campaignStatus = String(row.campaign_status).trim();
      entry.metrics[metricName] = {
        targetValue: toFiniteNumberLoose(row?.target_value),
        baselineAverage: toFiniteNumberLoose(row?.baseline_average),
        absoluteChange,
        percentChange
      };
      entry.score += Math.abs(percentChange ?? absoluteChange);
      positiveCampaignMap.set(campaignId, entry);
    }
  }

  const topCampaignDrivers = Array.from(campaignMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const topPositiveCampaigns = Array.from(positiveCampaignMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const changeEvents = Array.isArray(changeEventsRaw) ? changeEventsRaw : [];
  const changeSummary = summarizeChangeEventSignals(changeEvents);
  const relevantChangeEvents = changeSummary.events.filter((event) =>
    /status|budget|bid|bidding|target roas|target cpa|policy|verification/i.test(event.labelText)
  );

  const diagnosis = diagnosisRaw || {};
  const accountName = targetSummaryRaw?.account_name || baselineSummaryRaw?.account_name || "IndiaMART";
  const budgetLostShare = impressionShareSnapshot?.summary?.maxBudgetLostShare;
  const rankLostShare = impressionShareSnapshot?.summary?.maxRankLostShare;
  const hasTrafficCliff =
    accountPercentChange.clicks != null &&
    accountPercentChange.clicks <= -20 &&
    accountPercentChange.impressions != null &&
    accountPercentChange.impressions <= -20;
  const hasStableConversionRate = conversionRateChange == null || Math.abs(conversionRateChange) <= 15;
  const costDown = accountPercentChange.cost != null && accountPercentChange.cost <= -20;
  const bidOrBudgetSignals =
    changeSummary.counts.budget +
    changeSummary.counts.bidding +
    changeSummary.counts.target_roas +
    changeSummary.counts.target_cpa;
  const statusSignals = changeSummary.counts.status;
  const policySignals = changeSummary.counts.policy + changeSummary.counts.verification;
  let rootCauseLabel = "mixed_pressure";
  let rootCauseLine = "The data suggests mixed traffic and efficiency pressure.";
  if (hasTrafficCliff && hasStableConversionRate) {
    if (Number.isFinite(budgetLostShare) && budgetLostShare >= 20 && (!Number.isFinite(rankLostShare) || budgetLostShare >= rankLostShare)) {
      rootCauseLabel = "budget_constraint";
      rootCauseLine = "The main driver looks like budget pressure: impressions and clicks collapsed, and the impression-share snapshot suggests budget-lost share is high.";
    } else if (Number.isFinite(rankLostShare) && rankLostShare >= 20 && (!Number.isFinite(budgetLostShare) || rankLostShare > budgetLostShare)) {
      rootCauseLabel = "auction_competitiveness";
      rootCauseLine = "The main driver looks like auction competitiveness or ad-rank pressure: traffic collapsed and the impression-share snapshot suggests rank-lost share is high.";
    } else if (bidOrBudgetSignals > 0) {
      rootCauseLabel = "recent_bid_or_budget_change";
      rootCauseLine = "The main driver appears to be a recent bid, budget, target ROAS, or target CPA change that coincides with the traffic collapse.";
    } else if (statusSignals > 0) {
      rootCauseLabel = "status_or_serving_shift";
      rootCauseLine = "The main driver appears to be a status or serving shift captured in change history.";
    } else {
      rootCauseLabel = "broad_traffic_contraction";
      rootCauseLine = "The main driver is broad traffic contraction: clicks and impressions fell sharply across multiple campaigns while conversion rate stayed relatively close to baseline.";
    }
  } else if (accountPercentChange.conversions != null && accountPercentChange.conversions <= -20 && conversionRateChange != null && conversionRateChange <= -20) {
    rootCauseLabel = "conversion_rate_regression";
    rootCauseLine = "The main driver is a conversion-efficiency regression: traffic fell, but the bigger problem is that clicks are converting worse than before.";
  } else if (costDown && (hasTrafficCliff || accountPercentChange.conversions != null && accountPercentChange.conversions <= -20)) {
    rootCauseLabel = "serving_or_budget_suppression";
    rootCauseLine = "The main driver is serving or budget suppression: spend, clicks, and impressions all fell together.";
  } else if (policySignals > 0) {
    rootCauseLabel = "policy_or_verification_change_history";
    rootCauseLine = "Change history contains policy or verification-related edits, but this does not by itself prove a live policy or verification block.";
  }

  const lines = [
    `Executive read: ${accountName} (${cid}) had a traffic cliff on ${targetDate}, not a slow trend.`,
    `Primary cause: ${rootCauseLine}`,
    "",
    "Evidence:",
    `- Clicks: ${formatNumber(accountTotals.target.clicks)} vs ${formatNumber(accountTotals.baselineDaily.clicks)} avg/day (${formatSignedPercent(accountPercentChange.clicks)})`,
    `- Impressions: ${formatNumber(accountTotals.target.impressions)} vs ${formatNumber(accountTotals.baselineDaily.impressions)} avg/day (${formatSignedPercent(accountPercentChange.impressions)})`,
    `- Cost: INR ${formatNumber(accountTotals.target.cost)} vs INR ${formatNumber(accountTotals.baselineDaily.cost)} avg/day (${formatSignedPercent(accountPercentChange.cost)})`,
    `- Conversions: ${formatNumber(accountTotals.target.conversions)} vs ${formatNumber(accountTotals.baselineDaily.conversions)} avg/day (${formatSignedPercent(accountPercentChange.conversions)})`,
    `- Conversion rate: ${targetConversionRate == null ? "N/A" : `${(targetConversionRate * 100).toFixed(2)}%`} vs ${baselineConversionRate == null ? "N/A" : `${(baselineConversionRate * 100).toFixed(2)}%`} (${formatSignedPercent(conversionRateChange)})`
  ];

  if (topPositiveCampaigns.length) {
    lines.push("", "What went right or stayed resilient:");
    topPositiveCampaigns.forEach((campaign) => {
      const metricParts = [];
      for (const metricName of ["conversions", "clicks", "impressions", "cost"]) {
        const metric = campaign.metrics[metricName];
        if (!metric) continue;
        metricParts.push(`${metricName} ${formatSignedPercent(metric.percentChange)}`);
      }
      lines.push(`- ${campaign.campaignName || "Unknown campaign"} (ID ${campaign.campaignId})${metricParts.length ? `: ${metricParts.join("; ")}` : ""}`);
    });
  }

  lines.push("", "What went wrong:");
  topCampaignDrivers.slice(0, 5).forEach((campaign) => {
    const metricParts = [];
    for (const metricName of ["conversions", "clicks", "impressions", "cost"]) {
      const metric = campaign.metrics[metricName];
      if (!metric) continue;
      metricParts.push(`${metricName} ${formatSignedPercent(metric.percentChange)}`);
    }
    lines.push(`- ${campaign.campaignName || "Unknown campaign"} (ID ${campaign.campaignId})${metricParts.length ? `: ${metricParts.join("; ")}` : ""}`);
  });

  lines.push("", "Recent change signals:");
  lines.push(`- ${changeSummary.counts.status} status-related change(s)`);
  lines.push(`- ${changeSummary.counts.budget} budget-related change(s)`);
  lines.push(`- ${changeSummary.counts.bidding} bid/bidding change(s)`);
  lines.push(`- ${changeSummary.counts.target_roas} target ROAS change(s)`);
  lines.push(`- ${changeSummary.counts.target_cpa} target CPA change(s)`);
  lines.push(`- ${changeSummary.counts.policy} policy-related change(s)`);
  lines.push(`- ${changeSummary.counts.verification} verification-related change(s)`);

  if (impressionShareSnapshot?.available && impressionShareSnapshot.items.length) {
    lines.push("", "Impression-share clues:");
    impressionShareSnapshot.items.forEach((item) => {
      const shareParts = [];
      if (Number.isFinite(item.searchShare)) shareParts.push(`search share ${item.searchShare.toFixed(2)}%`);
      if (Number.isFinite(item.budgetLostShare)) shareParts.push(`budget lost ${item.budgetLostShare.toFixed(2)}%`);
      if (Number.isFinite(item.rankLostShare)) shareParts.push(`rank lost ${item.rankLostShare.toFixed(2)}%`);
      if (Number.isFinite(item.absoluteTopShare)) shareParts.push(`absolute top ${item.absoluteTopShare.toFixed(2)}%`);
      lines.push(`- ${item.campaignName || "Unknown campaign"} (ID ${item.campaignId})${shareParts.length ? `: ${shareParts.join("; ")}` : ""}`);
    });
  } else {
    lines.push("", "Impression-share clues: not available from the queried fields.");
  }

  lines.push(
    "",
    "Immediate actions:",
    rootCauseLabel === "budget_constraint"
      ? "- Raise or rebalance budget on the constrained campaigns first, then recheck impression share and conversions after one full day."
      : rootCauseLabel === "auction_competitiveness"
        ? "- Improve bid competitiveness on the affected campaigns, then recheck rank-lost impression share and clicks after one full day."
        : rootCauseLabel === "recent_bid_or_budget_change"
          ? "- Review the recent bid, budget, target ROAS, or target CPA change and roll back or soften it if it coincides with the dip."
          : rootCauseLabel === "status_or_serving_shift"
            ? "- Review the recent status or serving changes first, because those can suppress traffic immediately."
            : "- Review the biggest traffic losers first, then check budgets, bids, eligibility, and search terms before increasing spend.",
    "- If the Ads UI shows an active policy or verification alert, treat that as the first blocker to resolve, but do not assume one from this data alone.",
    "- On campaigns spending without conversions, inspect search terms, landing pages, feed quality, and tracking before scaling."
  );

  lines.push("", "What not to assume:");
  lines.push("- I cannot verify a live policy or verification block from the available signals alone.");
  lines.push("- This is not just a weak-conversion problem; the dominant issue is upstream traffic loss.");

  return {
    text: lines.join("\n"),
    customerIdUsed: cid,
    mode: "root-cause-fast-path",
    result: {
      target_date: targetDate,
      baseline_start: baselineStart,
      baseline_end: baselineEnd,
      account_totals: accountTotals,
      account_percent_change: accountPercentChange,
      conversion_rate_change: conversionRateChange,
      top_campaign_drivers: topCampaignDrivers,
      top_positive_campaigns: topPositiveCampaigns,
      root_cause_label: rootCauseLabel,
      impression_share_snapshot: impressionShareSnapshot,
      change_event_counts: changeSummary.counts,
      relevant_change_events: relevantChangeEvents,
      diagnosis
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

  if (isMetricDipRootCauseQuestion(job.message)) {
    await updateJob(job.id, { phase: "ads" });
    const out = await runMetricDipRootCauseFastPath(job.customerId, context);
    return { ...out, interpretedQuery: job.interpretedQuery || "" };
  }

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
