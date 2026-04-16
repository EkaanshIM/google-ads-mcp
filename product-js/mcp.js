import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

let clientPromise = null;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function repoRoot() {
  // product-js/ -> repo root
  return path.resolve(process.cwd(), "..");
}

function pythonCommand() {
  if (process.env.MCP_PYTHON) return process.env.MCP_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

function mcpEnv() {
  // Pass through only what the MCP server needs.
  const allow = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_PROJECT_ID",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN"
  ];
  const env = { ...process.env };
  // Keep process env for Python, but ensure required values exist.
  requireEnv("GOOGLE_ADS_DEVELOPER_TOKEN");
  for (const k of allow) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function parseArgsEnv(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch {
    // Fall through: space-split.
  }
  return value
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mcpCommandAndArgs() {
  // Override hook: lets you run the server from pipx or any other launcher.
  // Example:
  //   MCP_SERVER_COMMAND=pipx
  //   MCP_SERVER_ARGS=["run","google-ads-mcp"]
  const cmd = process.env.MCP_SERVER_COMMAND;
  if (cmd) {
    return {
      command: cmd,
      args: parseArgsEnv(process.env.MCP_SERVER_ARGS) ?? []
    };
  }

  // Default: run from this repo via python module.
  return {
    command: pythonCommand(),
    args: ["-m", "ads_mcp.server"]
  };
}

export async function getMcpClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    // Run the MCP server from the repo itself via stdio.
    const { command, args } = mcpCommandAndArgs();
    const transport = new StdioClientTransport({
      command,
      args,
      cwd: repoRoot(),
      env: mcpEnv()
    });

    const client = new Client(
      { name: "product-js", version: "0.0.1" },
      { capabilities: {} }
    );
    await client.connect(transport);
    return client;
  })();

  return clientPromise;
}
