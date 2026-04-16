# JS Demo UI (No Docker Needed)

This is a lightweight browser UI + API written in Node.js for internal demos.

It calls the Google Ads API directly (using your OAuth + refresh token), so it
does **not** need an MCP client implementation and does **not** require Docker.

## Prereqs

- Node.js 18+ (recommended: 20+)

## Setup

From the repo root:

```bash
cd product-js
npm install
cp .env.example .env
```

Fill `.env` with your values (same keys you already use on the server).

## Run

```bash
npm run dev
```

Open:

`http://SERVER_IP:3100/`

## Notes

- Change history uses `change_event` which only supports the last 30 days.
