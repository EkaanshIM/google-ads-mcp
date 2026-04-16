import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAdsApi } from "google-ads-api";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function adsClient() {
  return new GoogleAdsApi({
    client_id: requireEnv("GOOGLE_ADS_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_ADS_CLIENT_SECRET"),
    developer_token: requireEnv("GOOGLE_ADS_DEVELOPER_TOKEN")
  });
}

function adsCustomer(customerId) {
  const client = adsClient();
  return client.Customer({
    customer_id: String(customerId),
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
      ? String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
      : undefined,
    refresh_token: requireEnv("GOOGLE_ADS_REFRESH_TOKEN")
  });
}

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

app.get("/api/customers", async (req, res) => {
  try {
    const client = adsClient();
    // List accessible customers from the current auth context.
    const names = await client.listAccessibleCustomers(requireEnv("GOOGLE_ADS_REFRESH_TOKEN"));
    res.json({ resource_names: names });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.get("/api/campaigns", async (req, res) => {
  const customerId = req.query.customer_id;
  if (!customerId) return res.status(400).json({ error: "customer_id required" });

  try {
    const customer = adsCustomer(customerId);
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type
      FROM campaign
      ORDER BY campaign.name
      LIMIT 200
    `;
    const rows = await customer.query(query);
    res.json(rows);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.get("/api/performance", async (req, res) => {
  const customerId = req.query.customer_id;
  const days = Number(req.query.days || 14);
  if (!customerId) return res.status(400).json({ error: "customer_id required" });
  if (!(days >= 1 && days <= 30)) return res.status(400).json({ error: "days must be 1..30" });

  try {
    const customer = adsCustomer(customerId);
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversion_value
      FROM campaign
      WHERE segments.date DURING LAST_${days}_DAYS
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    `;
    const rows = await customer.query(query);
    res.json(rows);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.get("/api/change_history", async (req, res) => {
  const customerId = req.query.customer_id;
  const days = Number(req.query.days || 14);
  const limit = Number(req.query.limit || 50);
  if (!customerId) return res.status(400).json({ error: "customer_id required" });
  if (!(days >= 1 && days <= 30)) return res.status(400).json({ error: "days must be 1..30" });
  if (!(limit >= 1 && limit <= 10000)) return res.status(400).json({ error: "limit must be 1..10000" });

  try {
    const customer = adsCustomer(customerId);
    // change_event supports last 30 days only. Filter to campaign changes for demos.
    const query = `
      SELECT
        change_event.change_date_time,
        change_event.user_email,
        change_event.change_resource_type,
        change_event.change_resource_name,
        change_event.resource_change_operation,
        change_event.changed_fields
      FROM change_event
      WHERE change_event.change_date_time DURING LAST_${days}_DAYS
        AND change_event.change_resource_type = 'CAMPAIGN'
      ORDER BY change_event.change_date_time DESC
      LIMIT ${limit}
    `;
    const rows = await customer.query(query);
    res.json(rows);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

const port = Number(process.env.PORT || 3100);
app.listen(port, "0.0.0.0", () => {
  console.log(`Demo UI listening on http://0.0.0.0:${port}`);
});
