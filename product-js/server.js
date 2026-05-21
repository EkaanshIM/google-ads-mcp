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
    await updateJob(job.id, {
      status: "failed",
      phase: "error",
      completedAt: new Date().toISOString(),
      error: publicErrorMessage(e)
    });
    await appendSessionTurns(job.sessionId, [
      { role: "user", text: job.message, at: job.createdAt },
      { role: "assistant", text: `Request failed: ${publicErrorMessage(e)}`, at: new Date().toISOString() }
    ]);
    await logDebugEvent("chat_job.failed", {
      jobId: job.id,
      sessionId: job.sessionId,
      customerId: job.customerId,
      error: publicErrorMessage(e)
    });
  } finally {
    activeJobPromises.delete(job.id);
  }
}

function publicErrorMessage(error) {
  const message = error?.message ?? String(error);
  const lower = message.toLowerCase();
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
