# Google Ads MCP Demo (No Docker)

This is a lightweight browser UI + API written in Node.js for internal demos.

It uses:

- Gemini API (function calling)
- The official Google Ads MCP server (stdio)

So you can type natural-language questions and have the backend call MCP tools
to query Google Ads.

If Gemini API key quota is blocked, you can switch to **Vertex AI** auth (ADC)
instead. See `.env.example`.

## Prereqs

- Node.js 18+ (recommended: 20+)
- Python 3.10+ (needed to run the MCP server)

## Setup

From the repo root:

```bash
cd product-js
npm install
cp .env.example .env
```

Fill `.env` with your values (same keys you already use on the server).

Install Python deps for the MCP server (from repo root):

```bash
python -m pip install -e .
```

## Run

```bash
npm run dev
```

Open:

`http://SERVER_IP:3100/`

## Notes

- If you prefer running the MCP server via `pipx`, set `MCP_SERVER_COMMAND` and
  `MCP_SERVER_ARGS` in `.env`.
- For Vertex AI, set `GOOGLE_GENAI_USE_VERTEXAI=true` and configure ADC.
- `GEMINI_MAX_TOOL_STEPS` controls how many automatic MCP tool calls the Gemini
  SDK can make for one answer. Keep it high enough for multi-query analytics
  such as 7-day average comparisons.
- This Node server uses the Gemini API directly. It does not depend on Gemini
  CLI approval settings in production; all MCP tools supplied by the backend are
  available to Gemini automatically through the SDK.
- Debug events are written as JSONL to `data/debug-events.jsonl` by default.
  They include frontend chat requests, prepared Gemini prompts, Gemini MCP tool
  calls, tool arguments, compact tool result summaries, and job outcomes. Set
  `DEBUG_LOG_FILE` to override the path.
- `DEBUG_TRACE_IN_RESPONSE=true` can temporarily show a compact execution trace
  in each frontend answer. Keep it disabled for manager-facing production UI;
  JSONL logs still capture the full debugging detail.
