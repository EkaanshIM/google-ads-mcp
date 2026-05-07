import dotenv from "dotenv";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logDebugEvent, summarizeMcpResult, debugLogFile } from "./debugLogger.js";
import { runGeminiWithMcp } from "./geminiAgent.js";
import { getMcpClient } from "./mcp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Important: when running under pm2, cwd can differ. Always load the env file
// located next to this server entrypoint.
dotenv.config({ path: path.join(__dirname, ".env") });
const chatJobsDir = path.join(__dirname, "data", "chat-jobs");
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

app.post("/api/chat", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const requestedCustomerId = typeof req.body?.customerId === "string" ? req.body.customerId.trim() : "";
  const customerId = resolvedCustomerId(requestedCustomerId);
  if (!message) return res.status(400).json({ error: "message is required" });

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: "queued",
    message,
    customerId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    await logDebugEvent("frontend.chat_request_received", {
      jobId,
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
      status: job.status,
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
    userMessage: job.message
  };

  if (isPausedLast24HoursQuestion(job.message)) {
    return runPausedCampaignFastPath(job.customerId, context);
  }

  if (isProductMultipleCampaignCountQuestion(job.message)) {
    return runProductMultipleCampaignFastPath(job.customerId, context);
  }

  const out = await runGeminiWithMcp({
    message: job.message,
    customerId: job.customerId,
    jobId: job.id
  });
  return {
    ...out,
    customerIdUsed: resolvedCustomerId(job.customerId) || null,
    mode: "gemini"
  };
}

async function queueChatJob(job) {
  await updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
  try {
    const result = await runChatJob(job);
    await updateJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result
    });
    await logDebugEvent("chat_job.completed", {
      jobId: job.id,
      customerId: job.customerId,
      mode: result?.mode || null,
      textPreview: String(result?.text || "").slice(0, 4000)
    });
  } catch (e) {
    await updateJob(job.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: publicErrorMessage(e)
    });
    await logDebugEvent("chat_job.failed", {
      jobId: job.id,
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

function serializeChatResponse(job) {
  if (job.status === "completed") {
    return {
      status: "completed",
      text: job.result?.text || "",
      result: job.result || null,
      customerIdUsed: job.result?.customerIdUsed || null,
      mode: job.result?.mode || null,
      jobId: job.id
    };
  }

  if (job.status === "failed") {
    return {
      status: "failed",
      error: job.error || "Unknown error",
      jobId: job.id
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
