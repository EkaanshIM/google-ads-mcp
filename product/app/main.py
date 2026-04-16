import os
from datetime import date, timedelta

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from google.ads.googleads.client import GoogleAdsClient
from google.oauth2.credentials import Credentials


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _google_ads_client() -> GoogleAdsClient:
    creds = Credentials.from_authorized_user_info(
        {
            "type": "authorized_user",
            "client_id": _require_env("GOOGLE_ADS_CLIENT_ID"),
            "client_secret": _require_env("GOOGLE_ADS_CLIENT_SECRET"),
            "refresh_token": _require_env("GOOGLE_ADS_REFRESH_TOKEN"),
        },
        scopes=["https://www.googleapis.com/auth/adwords"],
    )

    args = {
        "credentials": creds,
        "developer_token": _require_env("GOOGLE_ADS_DEVELOPER_TOKEN"),
        "use_proto_plus": True,
    }
    login_customer_id = os.environ.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID")
    if login_customer_id:
        args["login_customer_id"] = login_customer_id

    return GoogleAdsClient(**args)


app = FastAPI(title="Google Ads Demo UI")


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    # Single-file UI for quick internal demos.
    return """<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Google Ads Demo</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
      label { display:block; font-size: 12px; color:#444; margin-bottom: 6px; }
      input, select, button { padding: 10px 12px; border-radius: 10px; border: 1px solid #ddd; }
      button { cursor: pointer; background: #0b57d0; color: #fff; border: 0; }
      button.secondary { background: #efefef; color:#111; border: 1px solid #ddd; }
      pre { background:#0b1220; color:#d8e3ff; padding: 14px; border-radius: 14px; overflow:auto; }
      .card { border: 1px solid #eee; border-radius: 16px; padding: 14px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      .muted { color:#666; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>Google Ads Demo UI</h1>
    <p class="muted">Internal demo: lists customers, campaigns, performance and change history.</p>

    <div class="card">
      <div class="row">
        <div>
          <label>Customer ID</label>
          <input id="customerId" placeholder="6475421500" />
        </div>
        <div>
          <label>Days</label>
          <select id="days">
            <option value="7">Last 7 days</option>
            <option value="14" selected>Last 14 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        <button onclick="run('customers')">List Customers</button>
        <button onclick="run('campaigns')" class="secondary">List Campaigns</button>
        <button onclick="run('performance')" class="secondary">Performance</button>
        <button onclick="run('changes')" class="secondary">Change History</button>
      </div>
    </div>

    <h2 style="font-size:14px; margin-top:18px;">Output</h2>
    <pre id="out">Ready.</pre>

    <script>
      async function run(kind) {
        const out = document.getElementById('out');
        out.textContent = 'Loading...';

        const customerId = document.getElementById('customerId').value.trim();
        const days = document.getElementById('days').value;

        let url = '';
        if (kind === 'customers') url = '/api/customers';
        if (kind === 'campaigns') url = '/api/campaigns?customer_id=' + encodeURIComponent(customerId);
        if (kind === 'performance') url = '/api/performance?customer_id=' + encodeURIComponent(customerId) + '&days=' + encodeURIComponent(days);
        if (kind === 'changes') url = '/api/change_history?customer_id=' + encodeURIComponent(customerId) + '&days=' + encodeURIComponent(days) + '&limit=50';

        try {
          const res = await fetch(url);
          const text = await res.text();
          out.textContent = text;
        } catch (e) {
          out.textContent = String(e);
        }
      }
    </script>
  </body>
</html>"""


@app.get("/api/customers")
def list_accessible_customers():
    client = _google_ads_client()
    service = client.get_service("CustomerService")
    response = service.list_accessible_customers()
    return {"resource_names": list(response.resource_names)}


@app.get("/api/campaigns")
def campaigns(customer_id: str = Query(..., min_length=3)):
    client = _google_ads_client()
    ga = client.get_service("GoogleAdsService")

    query = """
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type
      FROM campaign
      ORDER BY campaign.name
      LIMIT 200
    """
    rows = ga.search_stream(customer_id=customer_id, query=query)
    out = []
    for batch in rows:
        for row in batch.results:
            c = row.campaign
            out.append(
                {
                    "campaign.id": c.id,
                    "campaign.name": c.name,
                    "campaign.status": c.status.name,
                    "campaign.advertising_channel_type": c.advertising_channel_type.name,
                }
            )
    return out


@app.get("/api/performance")
def performance(
    customer_id: str = Query(..., min_length=3),
    days: int = Query(7, ge=1, le=30),
):
    client = _google_ads_client()
    ga = client.get_service("GoogleAdsService")

    start = (date.today() - timedelta(days=days)).isoformat()
    end = date.today().isoformat()

    query = f"""
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
      WHERE segments.date BETWEEN '{start}' AND '{end}'
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    """

    rows = ga.search_stream(customer_id=customer_id, query=query)
    out = []
    for batch in rows:
        for row in batch.results:
            out.append(
                {
                    "campaign.id": row.campaign.id,
                    "campaign.name": row.campaign.name,
                    "metrics.impressions": row.metrics.impressions,
                    "metrics.clicks": row.metrics.clicks,
                    "metrics.ctr": row.metrics.ctr,
                    "metrics.cost_micros": row.metrics.cost_micros,
                    "metrics.conversions": row.metrics.conversions,
                    "metrics.conversion_value": row.metrics.conversion_value,
                }
            )
    return out


@app.get("/api/change_history")
def change_history(
    customer_id: str = Query(..., min_length=3),
    days: int = Query(14, ge=1, le=30),
    limit: int = Query(50, ge=1, le=10000),
):
    client = _google_ads_client()
    ga = client.get_service("GoogleAdsService")

    # change_event only supports the last 30 days; enforce finite date range.
    start_dt = (date.today() - timedelta(days=days)).isoformat() + " 00:00:00"
    end_dt = date.today().isoformat() + " 23:59:59"

    query = f"""
      SELECT
        change_event.change_date_time,
        change_event.user_email,
        change_event.change_resource_type,
        change_event.change_resource_name,
        change_event.resource_change_operation,
        change_event.changed_fields
      FROM change_event
      WHERE change_event.change_date_time >= '{start_dt}'
        AND change_event.change_date_time <= '{end_dt}'
        AND change_event.change_resource_type = 'CAMPAIGN'
      ORDER BY change_event.change_date_time DESC
      LIMIT {limit}
    """

    try:
        rows = ga.search_stream(customer_id=customer_id, query=query)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    out = []
    for batch in rows:
        for row in batch.results:
            ce = row.change_event
            out.append(
                {
                    "change_event.change_date_time": str(ce.change_date_time),
                    "change_event.user_email": ce.user_email,
                    "change_event.change_resource_type": ce.change_resource_type.name,
                    "change_event.change_resource_name": ce.change_resource_name,
                    "change_event.resource_change_operation": ce.resource_change_operation.name,
                    "change_event.changed_fields": list(ce.changed_fields.paths),
                }
            )
    return out
