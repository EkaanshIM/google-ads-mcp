# Google Ads MCP on Cloud Run

This fork adds a remote MCP entrypoint so the server can be hosted on Google
Cloud Run using Streamable HTTP.

## What changed

- Keeps the original local `stdio` entrypoint for Gemini CLI.
- Adds `google-ads-mcp-cloud-run` for remote hosting.
- Exposes the MCP endpoint at `/mcp`.
- Exposes a health endpoint at `/healthz`.
- Supports OAuth credentials from either:
  - `GOOGLE_APPLICATION_CREDENTIALS`, or
  - `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
    `GOOGLE_ADS_REFRESH_TOKEN`

## Required secrets

At minimum you need:

- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` if you are querying through a manager account

Then choose one auth mode:

### Option 1: ADC file

- `GOOGLE_APPLICATION_CREDENTIALS` pointing to a mounted credentials file

### Option 2: OAuth env vars

- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN`

## Build and deploy

```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/google-ads-mcp
```

```bash
gcloud run deploy google-ads-mcp \
  --image gcr.io/PROJECT_ID/google-ads-mcp \
  --region REGION \
  --no-allow-unauthenticated \
  --set-secrets GOOGLE_ADS_DEVELOPER_TOKEN=google-ads-developer-token:latest \
  --set-secrets GOOGLE_ADS_LOGIN_CUSTOMER_ID=google-ads-login-customer-id:latest \
  --set-secrets GOOGLE_ADS_CLIENT_ID=google-ads-client-id:latest \
  --set-secrets GOOGLE_ADS_CLIENT_SECRET=google-ads-client-secret:latest \
  --set-secrets GOOGLE_ADS_REFRESH_TOKEN=google-ads-refresh-token:latest
```

Grant `roles/run.invoker` only to the users or groups who should be allowed to
use the shared MCP service.

For a quick internal demo you can temporarily use `--allow-unauthenticated`,
but that should not be the default for production business usage.

## Test after deploy

Health check:

```bash
curl https://YOUR_SERVICE_URL/healthz
```

Expected:

```json
{"status":"ok","transport":"streamable-http","mcp_path":"/mcp"}
```

## Client config

If your MCP client supports remote URLs directly:

```json
{
  "mcpServers": {
    "google-ads-remote": {
      "url": "https://YOUR_SERVICE_URL/mcp"
    }
  }
}
```

If the client requires a local command wrapper:

```json
{
  "mcpServers": {
    "google-ads-remote": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR_SERVICE_URL/mcp"]
    }
  }
}
```
