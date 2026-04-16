# Google Ads MCP Demo (No Docker)

This is a lightweight browser UI + API written in Node.js for internal demos.

It uses:

- Gemini API (function calling)
- The official Google Ads MCP server (stdio)

So you can type natural-language questions and have the backend call MCP tools
to query Google Ads.

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
