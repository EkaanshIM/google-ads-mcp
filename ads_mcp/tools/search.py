# Copyright 2026 Google LLC.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Tools for exposing the API Search method to the MCP server."""

from datetime import datetime, timedelta
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import time
from typing import Any, Dict, List
from ads_mcp.coordinator import mcp
import ads_mcp.utils as utils
import proto


_METRIC_ALIASES = {
    "clicks": "metrics.clicks",
    "impressions": "metrics.impressions",
    "ctr": "metrics.ctr",
    "average_cpc": "metrics.average_cpc",
    "avg_cpc": "metrics.average_cpc",
    "cpc": "metrics.average_cpc",
    "cost": "metrics.cost_micros",
    "cost_micros": "metrics.cost_micros",
    "conversions": "metrics.conversions",
    "conversion": "metrics.conversions",
    "cost_per_conversion": "metrics.cost_per_conversion",
}

DEFAULT_CURRENCY_CODE = "INR"

_PRODUCT_CAMPAIGN_OVERLAP_CACHE: Dict[Any, Dict[str, Any]] = {}
_PRODUCT_CAMPAIGN_OVERLAP_CACHE_LOCK = threading.Lock()
_PRODUCT_CAMPAIGN_OVERLAP_CACHE_TTL_SECONDS = 600
_PRODUCT_CAMPAIGN_OVERLAP_CACHE_MAX_ITEMS = 32


def _cache_get(cache: Dict[Any, Dict[str, Any]], lock, key):
    now = time.monotonic()
    with lock:
        cached = cache.get(key)
        if not cached:
            return None
        if now - cached["created_at"] > cached["ttl_seconds"]:
            cache.pop(key, None)
            return None
        value = dict(cached["value"])
        value["cache_hit"] = True
        value["cache_age_seconds"] = round(now - cached["created_at"], 2)
        return value


def _cache_set(cache: Dict[Any, Dict[str, Any]], lock, key, value, ttl_seconds):
    with lock:
        if len(cache) >= _PRODUCT_CAMPAIGN_OVERLAP_CACHE_MAX_ITEMS:
            oldest_key = min(cache.items(), key=lambda item: item[1]["created_at"])[0]
            cache.pop(oldest_key, None)
        cache[key] = {
            "created_at": time.monotonic(),
            "ttl_seconds": ttl_seconds,
            "value": dict(value),
        }


def _metric_field(metric: str) -> str:
    if not metric:
        return "metrics.conversions"
    normalized = metric.strip().lower()
    if normalized.startswith("metrics."):
        return normalized
    return _METRIC_ALIASES.get(normalized, f"metrics.{normalized}")


def _row_value(row: Dict[str, Any], field: str, default: Any = 0) -> Any:
    return row.get(field, default)


def _row_float(row: Dict[str, Any], field: str, default: float = 0.0) -> float:
    value = _row_value(row, field, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _plain_value(value: Any) -> Any:
    if isinstance(value, proto.Enum):
        return value.name
    if isinstance(value, proto.Message):
        return proto.Message.to_dict(value, preserving_proto_field_name=True)
    if isinstance(value, dict):
        return {key: _plain_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_value(item) for item in value]
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
        return [_plain_value(item) for item in value]
    return value


def _value_contains(value: Any, needle: str) -> bool:
    normalized_needle = (needle or "").strip().lower()
    if not normalized_needle:
        return False

    plain = _plain_value(value)
    if isinstance(plain, dict):
        return any(_value_contains(item, normalized_needle) for item in plain.values())
    if isinstance(plain, list):
        return any(_value_contains(item, normalized_needle) for item in plain)
    return normalized_needle in str(plain).lower()


def _date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


def _date_range_conditions(
    date_start: str | None, date_end: str | None
) -> List[str]:
    if date_start and date_end:
        return [f"segments.date BETWEEN '{date_start}' AND '{date_end}'"]
    if date_start:
        return [f"segments.date >= '{date_start}'"]
    if date_end:
        return [f"segments.date <= '{date_end}'"]
    return []


def _status_condition(resource: str, status: str | None) -> List[str]:
    if not status or status.upper() in {"ALL", "ANY"}:
        return []
    return [f"{resource}.status = '{status.upper()}'"]


def _money_units(value_micros: float) -> float:
    return value_micros / 1_000_000


def _has_money_field(fields: List[str]) -> bool:
    money_fields = {
        "metrics.cost_micros",
        "metrics.average_cpc",
        "metrics.cost_per_conversion",
        "customer.currency_code",
    }
    return any(field in money_fields for field in fields or [])


def _campaign_metric_bundle(row: Dict[str, Any]) -> Dict[str, Any]:
    cost_micros = _row_float(row, "metrics.cost_micros")
    avg_cpc_micros = _row_float(row, "metrics.average_cpc")
    conversions = _row_float(row, "metrics.conversions")
    return {
        "campaign_id": _row_value(row, "campaign.id"),
        "campaign_name": _row_value(row, "campaign.name"),
        "campaign_status": _row_value(row, "campaign.status"),
        "clicks": _row_float(row, "metrics.clicks"),
        "impressions": _row_float(row, "metrics.impressions"),
        "ctr": _row_float(row, "metrics.ctr"),
        "average_cpc": _money_units(avg_cpc_micros),
        "cost": _money_units(cost_micros),
        "cost_micros": cost_micros,
        "conversions": conversions,
        "cost_per_conversion": (
            _money_units(cost_micros) / conversions if conversions else None
        ),
        "currency_code": DEFAULT_CURRENCY_CODE,
    }


def _campaign_score(metrics: Dict[str, Any], metric: str, scoring_mode: str):
    normalized_metric = (metric or "").strip().lower()
    normalized_mode = (scoring_mode or "").strip().lower()

    if normalized_mode == "balanced" or normalized_metric in {
        "",
        "performance",
        "balanced",
    }:
        # Deterministic general-purpose score. Conversions are weighted highest,
        # while CTR, clicks, and lower CPC add secondary signal.
        return (
            (metrics["conversions"] * 1000)
            + metrics["clicks"]
            + (metrics["ctr"] * 10000)
            - ((metrics["average_cpc"] or 0) * 10)
        )

    if normalized_metric in {"average_cpc", "avg_cpc", "cpc"}:
        return -(metrics["average_cpc"] or 0)
    if normalized_metric == "cost_per_conversion":
        value = metrics["cost_per_conversion"]
        return -value if value is not None else float("-inf")
    if normalized_metric in {"cost", "spend", "cost_micros"}:
        return metrics["cost"]
    if normalized_metric == "ctr":
        return metrics["ctr"]
    if normalized_metric == "clicks":
        return metrics["clicks"]
    if normalized_metric == "impressions":
        return metrics["impressions"]
    return metrics["conversions"]


def _safe_pct_change(current: float, previous: float):
    if previous == 0:
        return None
    return ((current - previous) / previous) * 100


def _campaign_diagnostic_metrics(values: Dict[str, float]) -> Dict[str, Any]:
    clicks = float(values.get("clicks", 0) or 0)
    impressions = float(values.get("impressions", 0) or 0)
    cost_micros = float(values.get("cost_micros", 0) or 0)
    conversions = float(values.get("conversions", 0) or 0)
    cost = _money_units(cost_micros)
    return {
        "clicks": clicks,
        "impressions": impressions,
        "cost": cost,
        "cost_micros": cost_micros,
        "conversions": conversions,
        "ctr": clicks / impressions if impressions else 0,
        "average_cpc": cost / clicks if clicks else None,
        "conversion_rate": conversions / clicks if clicks else 0,
        "cost_per_conversion": cost / conversions if conversions else None,
    }


def _diagnostic_recommendations(metrics: Dict[str, Any], deltas: Dict[str, Any]) -> List[str]:
    recommendations = []
    conversions = metrics["conversions"]
    cost = metrics["cost"]
    clicks = metrics["clicks"]
    impressions = metrics["impressions"]
    cpa = metrics["cost_per_conversion"]
    ctr = metrics["ctr"]
    conversion_rate = metrics["conversion_rate"]
    conv_change = deltas.get("conversions_pct_change")
    cost_change = deltas.get("cost_pct_change")
    click_change = deltas.get("clicks_pct_change")

    if conversions > 0 and conv_change is not None and conv_change >= 20:
        recommendations.append(
            "Consider scaling budget or bid coverage cautiously because conversions improved strongly in the latest half of the period."
        )
    if cost > 0 and conversions == 0:
        recommendations.append(
            "Review spend leakage: this campaign spent without conversions, so check search terms, targeting, products/assets, and landing-page relevance before increasing budget."
        )
    if cpa is not None and cost_change is not None and conv_change is not None and cost_change > conv_change + 20:
        recommendations.append(
            "Cost is growing faster than conversions, so review bids/budget and cut low-intent queries or weak product groups."
        )
    if impressions > 0 and ctr < 0.01:
        recommendations.append(
            "CTR is low, so refresh ad assets, titles, descriptions, or audience/query targeting to improve relevance."
        )
    if clicks >= 30 and conversion_rate < 0.01:
        recommendations.append(
            "Clicks are not converting well, so check landing page experience, offer, tracking, and product/feed quality."
        )
    if click_change is not None and click_change < -25 and conversions > 0:
        recommendations.append(
            "Traffic dropped while the campaign still converts, so check budget limits, lost impression share, bid competitiveness, and eligibility issues."
        )

    return recommendations[:3]


def _date_span_days(date_start: str, date_end: str) -> int:
    try:
        return max(1, (_date(date_end) - _date(date_start)).days + 1)
    except Exception:
        return 1


def _currency(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 2)


def _pct(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value) * 100, 2)


def _scale_budget_decision(
    metrics: Dict[str, Any],
    date_start: str,
    date_end: str,
    target_cpa: float | None,
) -> Dict[str, Any] | None:
    conversions = float(metrics["conversions"] or 0)
    cpa = metrics["cost_per_conversion"]
    cost = float(metrics["cost"] or 0)
    if conversions < 10 or not cpa or cost <= 0:
        return None

    cpa_limit = float(target_cpa or cpa)
    cpa_ratio = cpa / cpa_limit if cpa_limit else 1
    if cpa_ratio <= 0.85 and conversions >= 30:
        lift_low, lift_high = 0.15, 0.25
        confidence = "medium"
    elif cpa_ratio <= 1.0 and conversions >= 30:
        lift_low, lift_high = 0.10, 0.20
        confidence = "medium"
    else:
        lift_low, lift_high = 0.05, 0.10
        confidence = "low"

    extra_budget_low = cost * lift_low
    extra_budget_high = cost * lift_high
    efficiency_guardrail = 0.7
    projected_conversions_low = (extra_budget_low / cpa) * efficiency_guardrail
    projected_conversions_high = (extra_budget_high / cpa) * efficiency_guardrail
    days = _date_span_days(date_start, date_end)

    return {
        "type": "scale_budget",
        "decision": f"Increase budget by {int(lift_low * 100)}-{int(lift_high * 100)}% if CPA stays within guardrail.",
        "why": (
            "Campaign has enough conversion volume to test scaling. "
            "Use a gradual increase because marginal traffic may be less efficient than current traffic."
        ),
        "current_period_cost": _currency(cost),
        "current_cpa": _currency(cpa),
        "target_or_guardrail_cpa": _currency(cpa_limit),
        "estimated_extra_period_budget": {
            "low": _currency(extra_budget_low),
            "high": _currency(extra_budget_high),
        },
        "estimated_extra_daily_budget": {
            "low": _currency(extra_budget_low / days),
            "high": _currency(extra_budget_high / days),
        },
        "expected_incremental_conversions": {
            "low": round(projected_conversions_low, 2),
            "high": round(projected_conversions_high, 2),
            "calculation": "extra budget / observed CPA * 0.70 efficiency guardrail",
        },
        "risk": "If CPA rises above the guardrail or conversion rate drops for 3-5 days, roll back the increase.",
        "confidence": confidence,
    }


def _bid_decision(metrics: Dict[str, Any], target_cpa: float | None) -> Dict[str, Any] | None:
    average_cpc = metrics["average_cpc"]
    cpa = metrics["cost_per_conversion"]
    conversions = float(metrics["conversions"] or 0)
    conversion_rate = float(metrics["conversion_rate"] or 0)
    if not average_cpc or conversions < 10 or not cpa:
        return None

    cpa_limit = float(target_cpa or cpa)
    if cpa <= cpa_limit and conversion_rate >= 0.02:
        lift_low, lift_high = 0.10, 0.15
    elif cpa <= cpa_limit:
        lift_low, lift_high = 0.05, 0.10
    else:
        return {
            "type": "bid_guardrail",
            "decision": "Do not increase bids until CPA improves or a higher target CPA is approved.",
            "why": "Observed CPA is above the provided/derived guardrail.",
            "current_average_cpc": _currency(average_cpc),
            "current_cpa": _currency(cpa),
            "target_or_guardrail_cpa": _currency(cpa_limit),
            "risk": "Bid increases can buy more volume but may worsen efficiency when CPA is already above target.",
            "confidence": "medium",
        }

    return {
        "type": "bid_increase",
        "decision": f"Increase max CPC or bid aggressiveness by {int(lift_low * 100)}-{int(lift_high * 100)}% only on proven terms/ad groups.",
        "why": "Observed CPA is within guardrail and the campaign converts at meaningful volume.",
        "current_average_cpc": _currency(average_cpc),
        "suggested_cpc_range": {
            "low": _currency(average_cpc * (1 + lift_low)),
            "high": _currency(average_cpc * (1 + lift_high)),
        },
        "current_cpa": _currency(cpa),
        "target_or_guardrail_cpa": _currency(cpa_limit),
        "risk": "Apply to proven segments first; avoid account-wide bid lifts without segment checks.",
        "confidence": "medium",
    }


def _term_metrics(row: Dict[str, Any]) -> Dict[str, Any]:
    cost = _money_units(_row_float(row, "metrics.cost_micros"))
    clicks = _row_float(row, "metrics.clicks")
    conversions = _row_float(row, "metrics.conversions")
    return {
        "search_term": _row_value(row, "search_term_view.search_term", ""),
        "ad_group_id": _row_value(row, "ad_group.id", ""),
        "ad_group_name": _row_value(row, "ad_group.name", ""),
        "clicks": clicks,
        "impressions": _row_float(row, "metrics.impressions"),
        "cost": _currency(cost),
        "conversions": conversions,
        "ctr": _pct(_row_float(row, "metrics.ctr")),
        "average_cpc": _currency(_money_units(_row_float(row, "metrics.average_cpc"))),
        "conversion_rate": _pct(conversions / clicks if clicks else 0),
        "cost_per_conversion": _currency(cost / conversions if conversions else None),
    }


def _product_status_conditions(status_group: str | None) -> List[str]:
    normalized = (status_group or "all").strip().lower()
    if normalized in {"all", "any", ""}:
        return []
    if normalized in {"enabled", "unpaused", "active", "servable", "eligible_or_limited"}:
        return ["shopping_product.status IN ('ELIGIBLE', 'ELIGIBLE_LIMITED')"]
    if normalized in {"eligible", "fully_eligible"}:
        return ["shopping_product.status = 'ELIGIBLE'"]
    if normalized in {"limited", "eligible_limited"}:
        return ["shopping_product.status = 'ELIGIBLE_LIMITED'"]
    if normalized in {"paused", "ineligible", "not_eligible", "not servable", "not_servable"}:
        return ["shopping_product.status = 'NOT_ELIGIBLE'"]
    return [f"shopping_product.status = '{status_group.upper()}'"]


def search(
    customer_id: str,
    fields: List[str],
    resource: str,
    conditions: List[str] = None,
    orderings: List[str] = None,
    limit: int | str = None,
) -> List[Dict[str, Any]]:
    """Fetches data from the Google Ads API using the search method

    Args:
        customer_id: The id of the customer
        fields: The fields to fetch
        resource: The resource to return fields from
        conditions: List of conditions to filter the data, combined using AND clauses
        orderings: How the data is ordered
        limit: The maximum number of rows to return

    """

    ga_service = utils.get_googleads_service("GoogleAdsService")

    query_parts = [f"SELECT {','.join(fields)} FROM {resource}"]

    if conditions:
        query_parts.append(f" WHERE {' AND '.join(conditions)}")

    if orderings:
        query_parts.append(f" ORDER BY {','.join(orderings)}")

    if limit:
        query_parts.append(f" LIMIT {limit}")

    query_parts.append(" PARAMETERS omit_unselected_resource_names=true")

    query = "".join(query_parts)
    utils.logger.info(f"ads_mcp.search query {query}")

    query_result = ga_service.search_stream(
        customer_id=customer_id, query=query
    )

    force_inr_currency = _has_money_field(fields)
    final_output: List = []
    for batch in query_result:
        for row in batch.results:
            formatted_row = utils.format_output_row(row, batch.field_mask.paths)
            if force_inr_currency:
                formatted_row["customer.currency_code"] = DEFAULT_CURRENCY_CODE
            final_output.append(formatted_row)
    return final_output


@mcp.tool()
def count_rows(
    customer_id: str,
    resource: str,
    field: str,
    conditions: List[str] = None,
) -> Dict[str, Any]:
    """Counts rows matching a Google Ads API search without returning all rows.

    Use this tool for "count", "how many", "total number of", and inventory-size
    questions where returning every matching row would be too large.
    For "running", "active", "live", or "enabled" campaign counts, use:
    resource="campaign", field="campaign.id", and
    conditions=["campaign.status = 'ENABLED'"]. Do not add serving_status or
    performance metric filters unless the user explicitly asks for those.
    For Merchant Center product enabled/unpaused/servable counts, use
    resource="shopping_product", field="shopping_product.resource_name", and
    conditions=["shopping_product.status IN ('ELIGIBLE', 'ELIGIBLE_LIMITED')"].
    For only fully eligible products, use
    conditions=["shopping_product.status = 'ELIGIBLE'"].
    For Merchant Center product paused/not servable/ineligible counts, use
    conditions=["shopping_product.status = 'NOT_ELIGIBLE'"]; Google Ads
    exposes product eligibility, not a literal product PAUSED enum.

    Args:
        customer_id: The id of the customer
        resource: The resource to count
        field: A selectable field from the resource, usually resource_name or id
        conditions: List of conditions to filter the data, combined using AND clauses
    """

    ga_service = utils.get_googleads_service("GoogleAdsService")

    query_parts = [f"SELECT {field} FROM {resource}"]
    if conditions:
        query_parts.append(f" WHERE {' AND '.join(conditions)}")
    query_parts.append(" PARAMETERS omit_unselected_resource_names=true")

    query = "".join(query_parts)
    utils.logger.info(f"ads_mcp.count_rows query {query}")

    query_result = ga_service.search_stream(
        customer_id=customer_id, query=query
    )

    total_results_count = 0
    for batch in query_result:
        total_results_count += len(batch.results)

    return {
        "resource": resource,
        "field": field,
        "conditions": conditions or [],
        "query": query,
        "total_results_count": int(total_results_count or 0),
    }


@mcp.tool()
def count_entities(
    customer_id: str,
    resource: str,
    field: str,
    conditions: List[str] = None,
    status: str = None,
    date_start: str = None,
    date_end: str = None,
) -> Dict[str, Any]:
    """Counts entities with optional status and date filters.

    Use this for generic entity count questions instead of fetching all rows.

    Args:
        customer_id: The id of the customer
        resource: Google Ads resource to count, e.g. campaign or shopping_product
        field: Selectable identifier field, e.g. campaign.id
        conditions: Additional GAQL conditions
        status: Optional status enum for resources with a status field
        date_start: Optional YYYY-MM-DD start date for segments.date
        date_end: Optional YYYY-MM-DD end date for segments.date
    """

    final_conditions = []
    final_conditions.extend(conditions or [])
    final_conditions.extend(_status_condition(resource, status))
    final_conditions.extend(_date_range_conditions(date_start, date_end))
    return count_rows(
        customer_id=customer_id,
        resource=resource,
        field=field,
        conditions=final_conditions,
    )


@mcp.tool()
def rank_campaigns(
    customer_id: str,
    date_start: str,
    date_end: str,
    metric: str = "performance",
    scoring_mode: str = "balanced",
    top_n: int = 5,
    status: str = "ENABLED",
) -> Dict[str, Any]:
    """Ranks campaigns deterministically for a date range.

    Use this for top/bottom/best/worst campaign performance questions. It fetches
    a full campaign candidate set, computes scores in code, and returns compact
    best/worst lists with supporting metrics.

    Args:
        customer_id: The id of the customer
        date_start: YYYY-MM-DD start date
        date_end: YYYY-MM-DD end date
        metric: Ranking metric or "performance" for balanced scoring
        scoring_mode: "balanced" or "metric"
        top_n: Number of best and worst campaigns to return
        status: Campaign status filter, usually ENABLED; use ALL for no status filter
    """

    final_top_n = max(1, min(int(top_n or 5), 25))
    fields = [
        "campaign.id",
        "campaign.name",
        "campaign.status",
        "metrics.clicks",
        "metrics.impressions",
        "metrics.ctr",
        "metrics.average_cpc",
        "metrics.cost_micros",
        "metrics.conversions",
        "customer.currency_code",
    ]
    conditions = []
    conditions.extend(_status_condition("campaign", status))
    conditions.extend(_date_range_conditions(date_start, date_end))

    rows = search(
        customer_id=customer_id,
        fields=fields,
        resource="campaign",
        conditions=conditions,
        limit=5000,
    )

    ranked = []
    for row in rows:
        metrics = _campaign_metric_bundle(row)
        score = _campaign_score(metrics, metric, scoring_mode)
        ranked.append({**metrics, "score": score})

    ranked.sort(key=lambda item: item["score"], reverse=True)
    return {
        "customer_id": customer_id,
        "date_start": date_start,
        "date_end": date_end,
        "status": status,
        "metric": metric,
        "scoring_mode": scoring_mode,
        "scoring_note": (
            "Balanced score weights conversions highest, then clicks and CTR, "
            "with lower CPC as a small positive signal."
            if (scoring_mode or "").lower() == "balanced"
            or (metric or "").lower() in {"performance", "balanced", ""}
            else "Metric score uses the requested metric directly; lower is better for CPC metrics."
        ),
        "candidate_count": len(ranked),
        "best": ranked[:final_top_n],
        "worst": list(reversed(ranked[-final_top_n:])) if ranked else [],
    }


@mcp.tool()
def diagnose_campaign_period(
    customer_id: str,
    date_start: str,
    date_end: str,
    status: str = "ENABLED",
    top_n: int = 8,
) -> Dict[str, Any]:
    """Diagnoses campaign performance and recommends optimization actions.

    Use this when the user asks what went right/wrong, why performance changed,
    or what campaign modifications are recommended for a period such as 4 weeks.
    The tool fetches campaign metrics by week, computes totals and period-half
    deltas, and returns grounded recommendations from the fetched data.

    Args:
        customer_id: The id of the customer
        date_start: YYYY-MM-DD start date
        date_end: YYYY-MM-DD end date
        status: Campaign status filter, usually ENABLED; use ALL for no status filter
        top_n: Number of strongest/weakest campaign diagnostics to return
    """

    final_top_n = max(1, min(int(top_n or 8), 25))
    fields = [
        "campaign.id",
        "campaign.name",
        "campaign.status",
        "segments.week",
        "metrics.clicks",
        "metrics.impressions",
        "metrics.cost_micros",
        "metrics.conversions",
        "customer.currency_code",
    ]
    conditions = []
    conditions.extend(_status_condition("campaign", status))
    conditions.extend(_date_range_conditions(date_start, date_end))

    rows = search(
        customer_id=customer_id,
        fields=fields,
        resource="campaign",
        conditions=conditions,
        limit=50000,
    )

    by_campaign: Dict[Any, Dict[str, Any]] = {}
    account_totals = {
        "clicks": 0.0,
        "impressions": 0.0,
        "cost_micros": 0.0,
        "conversions": 0.0,
    }
    weeks = set()
    currency_code = DEFAULT_CURRENCY_CODE

    for row in rows:
        campaign_id = _row_value(row, "campaign.id")
        week = _row_value(row, "segments.week", "")
        weeks.add(week)
        currency_code = DEFAULT_CURRENCY_CODE
        entry = by_campaign.setdefault(
            campaign_id,
            {
                "campaign_id": campaign_id,
                "campaign_name": _row_value(row, "campaign.name"),
                "campaign_status": _row_value(row, "campaign.status"),
                "weeks": {},
                "totals_raw": {
                    "clicks": 0.0,
                    "impressions": 0.0,
                    "cost_micros": 0.0,
                    "conversions": 0.0,
                },
            },
        )
        raw = {
            "clicks": _row_float(row, "metrics.clicks"),
            "impressions": _row_float(row, "metrics.impressions"),
            "cost_micros": _row_float(row, "metrics.cost_micros"),
            "conversions": _row_float(row, "metrics.conversions"),
        }
        entry["weeks"][week] = _campaign_diagnostic_metrics(raw)
        for key, value in raw.items():
            entry["totals_raw"][key] += value
            account_totals[key] += value

    sorted_weeks = sorted(day for day in weeks if day)
    split_index = max(1, len(sorted_weeks) // 2) if sorted_weeks else 0
    earlier_weeks = set(sorted_weeks[:split_index])
    later_weeks = set(sorted_weeks[split_index:])

    diagnostics = []
    for entry in by_campaign.values():
        earlier_raw = {
            "clicks": 0.0,
            "impressions": 0.0,
            "cost_micros": 0.0,
            "conversions": 0.0,
        }
        later_raw = dict(earlier_raw)

        for week, metrics in entry["weeks"].items():
            target = later_raw if week in later_weeks else earlier_raw
            target["clicks"] += metrics["clicks"]
            target["impressions"] += metrics["impressions"]
            target["cost_micros"] += metrics["cost_micros"]
            target["conversions"] += metrics["conversions"]

        totals = _campaign_diagnostic_metrics(entry["totals_raw"])
        earlier = _campaign_diagnostic_metrics(earlier_raw)
        later = _campaign_diagnostic_metrics(later_raw)
        deltas = {
            "clicks_pct_change": _safe_pct_change(later["clicks"], earlier["clicks"]),
            "impressions_pct_change": _safe_pct_change(
                later["impressions"], earlier["impressions"]
            ),
            "cost_pct_change": _safe_pct_change(later["cost"], earlier["cost"]),
            "conversions_pct_change": _safe_pct_change(
                later["conversions"], earlier["conversions"]
            ),
            "cost_per_conversion_pct_change": _safe_pct_change(
                later["cost_per_conversion"] or 0,
                earlier["cost_per_conversion"] or 0,
            ),
        }
        efficiency_score = (
            (totals["conversions"] * 1000)
            + (totals["clicks"] * 2)
            + (totals["ctr"] * 10000)
            - ((totals["cost_per_conversion"] or totals["cost"]) * 10)
        )
        risk_score = (
            (totals["cost"] if totals["conversions"] == 0 else 0)
            + max(0, totals["clicks"] - (totals["conversions"] * 30))
            + max(0, (deltas["cost_pct_change"] or 0) - (deltas["conversions_pct_change"] or 0))
        )
        diagnostics.append(
            {
                "campaign_id": entry["campaign_id"],
                "campaign_name": entry["campaign_name"],
                "campaign_status": entry["campaign_status"],
                "totals": totals,
                "earlier_period": {
                    "weeks": sorted(earlier_weeks),
                    "metrics": earlier,
                },
                "later_period": {
                    "weeks": sorted(later_weeks),
                    "metrics": later,
                },
                "deltas": deltas,
                "recommendations": _diagnostic_recommendations(totals, deltas),
                "efficiency_score": efficiency_score,
                "risk_score": risk_score,
            }
        )

    winners = sorted(diagnostics, key=lambda item: item["efficiency_score"], reverse=True)
    risks = sorted(diagnostics, key=lambda item: item["risk_score"], reverse=True)
    conversion_gainers = sorted(
        diagnostics,
        key=lambda item: item["deltas"]["conversions_pct_change"]
        if item["deltas"]["conversions_pct_change"] is not None
        else float("-inf"),
        reverse=True,
    )
    conversion_decliners = sorted(
        diagnostics,
        key=lambda item: item["deltas"]["conversions_pct_change"]
        if item["deltas"]["conversions_pct_change"] is not None
        else float("inf"),
    )

    return {
        "customer_id": customer_id,
        "date_start": date_start,
        "date_end": date_end,
        "status": status,
        "currency_code": currency_code,
        "campaign_count": len(diagnostics),
        "weeks": sorted_weeks,
        "comparison_method": (
            "Campaign totals are compared between the earlier half and later "
            "half of the selected weeks. Recommendations are heuristic and "
            "grounded only in clicks, impressions, conversions, cost, CTR, CPC, "
            "conversion rate, and CPA."
        ),
        "account_totals": _campaign_diagnostic_metrics(account_totals),
        "what_went_right": winners[:final_top_n],
        "what_went_wrong": risks[:final_top_n],
        "conversion_gainers": conversion_gainers[:final_top_n],
        "conversion_decliners": conversion_decliners[:final_top_n],
        "recommended_modification_types": [
            "Scale budget/bids cautiously on campaigns with conversion growth and acceptable CPA.",
            "Reduce or restructure spend on campaigns spending without conversions.",
            "Review search terms, targeting, product groups, and placements where clicks are high but conversion rate is low.",
            "Refresh ad assets/feed titles/descriptions where impressions are high but CTR is weak.",
            "Check landing page, tracking, offer, and product eligibility where traffic does not convert.",
        ],
    }


@mcp.tool()
def campaign_growth_decision_brief(
    customer_id: str,
    date_start: str,
    date_end: str,
    campaign_id: str = None,
    campaign_name: str = None,
    target_cpa: float = None,
    top_n: int = 8,
) -> Dict[str, Any]:
    """Builds a decision-ready growth plan for a campaign.

    Use this when the user wants a business-growth brain, boost plan, exact
    keyword/search-term ideas, bid/budget changes, expected impact, or what
    should be done next. Unlike mover diagnostics, this returns action
    recommendations even when performance is stable.

    Args:
        customer_id: The id of the customer
        date_start: YYYY-MM-DD start date
        date_end: YYYY-MM-DD end date
        campaign_id: Optional exact campaign id to analyze
        campaign_name: Optional campaign name to match when id is not provided
        target_cpa: Optional business target CPA in INR for scaling guardrails
        top_n: Number of search terms and decisions to return
    """

    final_top_n = max(1, min(int(top_n or 8), 25))
    campaign_conditions = _date_range_conditions(date_start, date_end)
    if campaign_id:
        campaign_conditions.append(f"campaign.id = {campaign_id}")
    elif campaign_name:
        escaped_name = str(campaign_name).replace("\\", "\\\\").replace("'", "\\'")
        campaign_conditions.append(f"campaign.name = '{escaped_name}'")

    campaign_rows = search(
        customer_id=customer_id,
        fields=[
            "campaign.id",
            "campaign.name",
            "campaign.status",
            "metrics.clicks",
            "metrics.impressions",
            "metrics.ctr",
            "metrics.average_cpc",
            "metrics.cost_micros",
            "metrics.conversions",
            "customer.currency_code",
        ],
        resource="campaign",
        conditions=campaign_conditions,
        limit=10,
    )

    if not campaign_rows:
        return {
            "customer_id": customer_id,
            "date_start": date_start,
            "date_end": date_end,
            "campaign_id": campaign_id,
            "campaign_name": campaign_name,
            "currency_code": DEFAULT_CURRENCY_CODE,
            "error": "No campaign rows matched the requested scope.",
        }

    campaign_row = campaign_rows[0]
    metrics = _campaign_metric_bundle(campaign_row)
    metrics["conversion_rate"] = (
        metrics["conversions"] / metrics["clicks"] if metrics["clicks"] else 0
    )
    days = _date_span_days(date_start, date_end)
    decisions = []

    scale_decision = _scale_budget_decision(metrics, date_start, date_end, target_cpa)
    if scale_decision:
        decisions.append(scale_decision)

    bid_decision = _bid_decision(metrics, target_cpa)
    if bid_decision:
        decisions.append(bid_decision)

    if metrics["impressions"] and metrics["ctr"] < 0.02:
        decisions.append(
            {
                "type": "relevance_lift",
                "decision": "Improve ad/feed relevance before aggressive scaling.",
                "why": "CTR is below 2%, so more budget may buy weak traffic unless relevance improves.",
                "current_ctr": _pct(metrics["ctr"]),
                "expected_impact": "A 10% CTR lift at the same impressions would add roughly "
                f"{round(metrics['clicks'] * 0.10, 0)} extra clicks in a similar period.",
                "risk": "Changing too many assets or feed titles at once makes attribution hard; test the highest-volume theme first.",
                "confidence": "medium",
            }
        )

    if metrics["clicks"] >= 100 and metrics["conversions"] == 0:
        decisions.append(
            {
                "type": "pause_or_restructure",
                "decision": "Do not boost this campaign yet; isolate wasted spend first.",
                "why": "The campaign has click volume but no conversions in the selected period.",
                "risk": "Scaling spend before fixing conversion leakage can increase loss.",
                "confidence": "high",
            }
        )

    search_term_note = None
    scale_terms: List[Dict[str, Any]] = []
    negative_terms: List[Dict[str, Any]] = []
    try:
        term_conditions = _date_range_conditions(date_start, date_end)
        if campaign_id:
            term_conditions.append(f"campaign.id = {campaign_id}")
        elif campaign_name:
            escaped_name = str(campaign_name).replace("\\", "\\\\").replace("'", "\\'")
            term_conditions.append(f"campaign.name = '{escaped_name}'")

        term_rows = search(
            customer_id=customer_id,
            fields=[
                "campaign.id",
                "campaign.name",
                "ad_group.id",
                "ad_group.name",
                "search_term_view.search_term",
                "metrics.clicks",
                "metrics.impressions",
                "metrics.ctr",
                "metrics.average_cpc",
                "metrics.cost_micros",
                "metrics.conversions",
            ],
            resource="search_term_view",
            conditions=term_conditions,
            limit=5000,
        )
        term_metrics = [_term_metrics(row) for row in term_rows]
        term_metrics = [term for term in term_metrics if term["search_term"]]
        scale_terms = sorted(
            [term for term in term_metrics if term["conversions"] > 0],
            key=lambda term: (
                term["conversions"],
                -(term["cost_per_conversion"] or 10**9),
                term["clicks"],
            ),
            reverse=True,
        )[:final_top_n]

        observed_cpa = metrics["cost_per_conversion"] or 0
        waste_threshold = max(observed_cpa * 0.75, metrics["average_cpc"] or 0)
        negative_terms = sorted(
            [
                term
                for term in term_metrics
                if term["conversions"] == 0
                and (
                    term["clicks"] >= 10
                    or float(term["cost"] or 0) >= waste_threshold
                )
            ],
            key=lambda term: (float(term["cost"] or 0), term["clicks"]),
            reverse=True,
        )[:final_top_n]

        if scale_terms:
            decisions.append(
                {
                    "type": "keyword_expansion",
                    "decision": "Use converting search terms as exact/phrase keyword or search-theme candidates.",
                    "exact_terms_to_consider": [term["search_term"] for term in scale_terms],
                    "why": "These terms already produced conversions in this campaign/date range.",
                    "expected_impact": "Expected impact depends on added eligible volume; monitor CPA by term for 7 days before expanding further.",
                    "risk": "Do not add broad variants until exact/phrase candidates hold CPA near campaign average.",
                    "confidence": "medium",
                }
            )

        if negative_terms:
            decisions.append(
                {
                    "type": "negative_keywords",
                    "decision": "Add non-converting high-cost search terms as negative keywords after checking business relevance.",
                    "exact_terms_to_review": [term["search_term"] for term in negative_terms],
                    "why": "These terms consumed clicks/spend without conversions in the selected period.",
                    "expected_impact": "Savings can be redirected into proven terms; estimate savings from each term's observed cost.",
                    "risk": "Do not negative terms that are strategically important or have assisted conversions outside this metric view.",
                    "confidence": "medium",
                }
            )
    except Exception as exc:
        search_term_note = (
            "Search-term drilldown was unavailable for this campaign/scope. "
            f"Reason: {exc}"
        )

    if not decisions:
        decisions.append(
            {
                "type": "stable_campaign_scale_test",
                "decision": "Run a controlled 5-10% budget scale test instead of taking no action.",
                "why": "No strong risk signal was detected, so the next useful business decision is a guarded growth test.",
                "expected_impact": (
                    "Use expected extra conversions = extra budget / observed CPA * 0.70. "
                    "Stop if CPA rises above guardrail."
                ),
                "risk": "Stable historical performance does not guarantee stable marginal traffic.",
                "confidence": "low",
            }
        )

    return {
        "customer_id": customer_id,
        "date_start": date_start,
        "date_end": date_end,
        "currency_code": DEFAULT_CURRENCY_CODE,
        "campaign": {
            "campaign_id": metrics["campaign_id"],
            "campaign_name": metrics["campaign_name"],
            "campaign_status": metrics["campaign_status"],
        },
        "period_days": days,
        "performance": {
            "clicks": metrics["clicks"],
            "impressions": metrics["impressions"],
            "cost": _currency(metrics["cost"]),
            "conversions": metrics["conversions"],
            "ctr": _pct(metrics["ctr"]),
            "average_cpc": _currency(metrics["average_cpc"]),
            "conversion_rate": _pct(metrics["conversion_rate"]),
            "cost_per_conversion": _currency(metrics["cost_per_conversion"]),
            "average_daily_cost": _currency(metrics["cost"] / days if days else metrics["cost"]),
        },
        "decisions": decisions[:final_top_n],
        "search_term_scale_candidates": scale_terms,
        "search_term_negative_candidates": negative_terms,
        "search_term_note": search_term_note,
        "decision_policy": (
            "Recommendations are metric-based decisions, not guaranteed outcomes. "
            "Validate against margin, inventory, conversion quality, and business priority. "
            "When target_cpa is missing, observed CPA is used as the guardrail."
        ),
    }


@mcp.tool()
def compare_campaigns_to_7day_average(
    customer_id: str,
    metric: str,
    target_date: str,
    top_n: int = 5,
    status: str = "ENABLED",
) -> Dict[str, Any]:
    """Compares campaign target-day metric values to the prior 7-day average.

    Use this for "largest change vs 7-day average" campaign questions.

    Args:
        customer_id: The id of the customer
        metric: Metric to compare, e.g. conversions, clicks, cost
        target_date: Target date in YYYY-MM-DD
        top_n: Number of changes to return
        status: Campaign status filter, usually ENABLED; use ALL for no status filter
    """

    metric_field = _metric_field(metric)
    target_dt = _date(target_date)
    baseline_start = (target_dt - timedelta(days=7)).strftime("%Y-%m-%d")
    baseline_end = (target_dt - timedelta(days=1)).strftime("%Y-%m-%d")
    combined_start = baseline_start
    combined_end = target_date
    final_top_n = max(1, min(int(top_n or 5), 25))

    fields = ["campaign.id", "campaign.name", "campaign.status", "segments.date", metric_field]
    conditions = []
    conditions.extend(_status_condition("campaign", status))
    conditions.extend(_date_range_conditions(combined_start, combined_end))

    rows = search(
        customer_id=customer_id,
        fields=fields,
        resource="campaign",
        conditions=conditions,
        limit=10000,
    )

    by_campaign: Dict[Any, Dict[str, Any]] = {}
    for row in rows:
        campaign_id = _row_value(row, "campaign.id")
        entry = by_campaign.setdefault(
            campaign_id,
            {
                "campaign_id": campaign_id,
                "campaign_name": _row_value(row, "campaign.name"),
                "daily": {},
            },
        )
        entry["daily"][_row_value(row, "segments.date")] = _row_float(row, metric_field)

    changes = []
    baseline_dates = [
        (target_dt - timedelta(days=offset)).strftime("%Y-%m-%d")
        for offset in range(7, 0, -1)
    ]
    for entry in by_campaign.values():
        baseline_values = [entry["daily"].get(day, 0.0) for day in baseline_dates]
        baseline_avg = sum(baseline_values) / 7
        target_value = entry["daily"].get(target_date, 0.0)
        absolute_change = target_value - baseline_avg
        pct_change = (
            (absolute_change / baseline_avg) * 100 if baseline_avg else None
        )
        changes.append(
            {
                "campaign_id": entry["campaign_id"],
                "campaign_name": entry["campaign_name"],
                "metric": metric_field,
                "target_date": target_date,
                "target_value": target_value,
                "baseline_start": baseline_start,
                "baseline_end": baseline_end,
                "baseline_average": baseline_avg,
                "absolute_change": absolute_change,
                "percent_change": pct_change,
            }
        )

    by_abs = sorted(changes, key=lambda item: abs(item["absolute_change"]), reverse=True)
    by_increase = sorted(changes, key=lambda item: item["absolute_change"], reverse=True)
    by_decrease = sorted(changes, key=lambda item: item["absolute_change"])
    return {
        "customer_id": customer_id,
        "metric": metric_field,
        "target_date": target_date,
        "baseline_start": baseline_start,
        "baseline_end": baseline_end,
        "status": status,
        "candidate_count": len(changes),
        "largest_changes": by_abs[:final_top_n],
        "largest_increases": by_increase[:final_top_n],
        "largest_decreases": by_decrease[:final_top_n],
    }


@mcp.tool()
def product_status_breakdown(customer_id: str) -> Dict[str, Any]:
    """Returns Merchant Center shopping product counts by eligibility status."""

    statuses = ["ELIGIBLE", "ELIGIBLE_LIMITED", "NOT_ELIGIBLE"]
    breakdown = {}
    for status in statuses:
        result = count_rows(
            customer_id=customer_id,
            resource="shopping_product",
            field="shopping_product.resource_name",
            conditions=[f"shopping_product.status = '{status}'"],
        )
        breakdown[status] = result["total_results_count"]

    return {
        "customer_id": customer_id,
        "breakdown": breakdown,
        "enabled_unpaused_servable_count": breakdown["ELIGIBLE"]
        + breakdown["ELIGIBLE_LIMITED"],
        "paused_not_servable_ineligible_count": breakdown["NOT_ELIGIBLE"],
        "note": (
            "Google Ads exposes Merchant Center product ad eligibility as "
            "shopping_product.status. There is no literal PAUSED product enum."
        ),
    }


@mcp.tool()
def count_products_by_status(
    customer_id: str, status_group: str = "enabled"
) -> Dict[str, Any]:
    """Counts shopping products by business status group.

    Args:
        customer_id: The id of the customer
        status_group: enabled/unpaused/active/servable, eligible, limited,
            paused/ineligible/not_eligible/not_servable, or all
    """

    conditions = _product_status_conditions(status_group)
    result = count_rows(
        customer_id=customer_id,
        resource="shopping_product",
        field="shopping_product.resource_name",
        conditions=conditions,
    )
    return {
        **result,
        "status_group": status_group,
        "note": (
            "enabled/unpaused/servable maps to ELIGIBLE + ELIGIBLE_LIMITED; "
            "paused/not servable maps to NOT_ELIGIBLE."
        ),
    }


@mcp.tool()
def count_products_in_multiple_campaigns(
    customer_id: str,
    min_campaign_count: int = 2,
    campaign_status: str = "ENABLED",
    product_status_group: str = "enabled",
    sample_size: int = 10,
    max_campaigns: int = 0,
    max_concurrency: int = 8,
    time_budget_seconds: int = 0,
) -> Dict[str, Any]:
    """Counts shopping products included in at least N different campaigns.

    Use this when the user asks for products running/showing/appearing in
    multiple campaigns. `shopping_product.campaign` requires campaign scope,
    so this tool first fetches campaigns, then queries shopping products once
    per campaign using the required equality filter and compares item IDs in
    code.

    Args:
        customer_id: The id of the customer
        min_campaign_count: Minimum number of distinct campaigns per product
        campaign_status: Campaign status filter, usually ENABLED; use ALL for no filter
        product_status_group: Product status group, usually enabled for
            ELIGIBLE + ELIGIBLE_LIMITED products
        sample_size: Number of matching product samples to return
        max_campaigns: Optional positive campaign scan cap. Leave as 0 to scan
            every available Shopping and Performance Max campaign.
        max_concurrency: Maximum campaign product queries to run at once
        time_budget_seconds: Optional safety budget. Leave as 0 for a full scan;
            pass a positive value to return partial results after that budget.
    """

    started_at = time.monotonic()
    final_min_campaign_count = max(2, int(min_campaign_count or 2))
    final_sample_size = max(0, min(int(sample_size or 10), 25))
    final_max_campaigns = max(0, int(max_campaigns or 0))
    final_max_concurrency = max(1, min(int(max_concurrency or 8), 12))
    final_time_budget_seconds = max(0, int(time_budget_seconds or 0))
    cache_key = (
        customer_id,
        final_min_campaign_count,
        campaign_status,
        product_status_group,
        final_sample_size,
        final_max_campaigns,
        final_max_concurrency,
        final_time_budget_seconds,
    )
    cached = _cache_get(
        _PRODUCT_CAMPAIGN_OVERLAP_CACHE,
        _PRODUCT_CAMPAIGN_OVERLAP_CACHE_LOCK,
        cache_key,
    )
    if cached:
        return cached

    campaign_conditions = _status_condition("campaign", campaign_status)
    campaign_conditions.append(
        "campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')"
    )
    product_status_conditions = _product_status_conditions(product_status_group)

    campaigns = search(
        customer_id=customer_id,
        fields=[
            "campaign.id",
            "campaign.name",
            "campaign.status",
            "campaign.advertising_channel_type",
        ],
        resource="campaign",
        conditions=campaign_conditions,
        limit=10000,
    )

    product_campaigns: Dict[str, Dict[str, Any]] = {}
    product_campaign_pair_count = 0
    skipped_campaigns = []
    processed_campaigns = 0
    timed_out_before_full_scan = False

    campaigns_to_scan = (
        campaigns[:final_max_campaigns] if final_max_campaigns > 0 else campaigns
    )

    def fetch_campaign_products(campaign: Dict[str, Any]) -> Dict[str, Any]:
        campaign_id = _row_value(campaign, "campaign.id")
        campaign_name = _row_value(campaign, "campaign.name")
        if not campaign_id:
            return {"campaign": campaign, "rows": [], "skipped": None}

        campaign_resource_name = f"customers/{customer_id}/campaigns/{campaign_id}"
        conditions = [
            f"shopping_product.campaign = '{campaign_resource_name}'",
            *product_status_conditions,
        ]

        try:
            rows = search(
                customer_id=customer_id,
                fields=[
                    "shopping_product.item_id",
                    "shopping_product.resource_name",
                    "shopping_product.status",
                    "shopping_product.campaign",
                ],
                resource="shopping_product",
                conditions=conditions,
                limit=100000,
            )
            return {"campaign": campaign, "rows": rows, "skipped": None}
        except Exception as error:
            return {
                "campaign": campaign,
                "rows": [],
                "skipped": {
                    "campaign_id": campaign_id,
                    "campaign_name": campaign_name,
                    "error": str(error),
                },
            }

    with ThreadPoolExecutor(max_workers=final_max_concurrency) as executor:
        next_index = 0
        while next_index < len(campaigns_to_scan):
            elapsed = time.monotonic() - started_at
            if (
                final_time_budget_seconds > 0
                and elapsed >= final_time_budget_seconds
            ):
                timed_out_before_full_scan = True
                break

            batch = campaigns_to_scan[next_index : next_index + final_max_concurrency]
            next_index += len(batch)
            futures = [executor.submit(fetch_campaign_products, campaign) for campaign in batch]

            for future in as_completed(futures):
                result = future.result()
                campaign = result["campaign"]
                campaign_id = _row_value(campaign, "campaign.id")
                campaign_name = _row_value(campaign, "campaign.name")
                skipped = result.get("skipped")
                if skipped:
                    skipped_campaigns.append(skipped)
                    continue

                processed_campaigns += 1
                rows = result["rows"]

                for row in rows:
                    product_key = str(
                        _row_value(row, "shopping_product.item_id")
                        or _row_value(row, "shopping_product.resource_name")
                    )
                    if not product_key:
                        continue

                    product_campaign_pair_count += 1
                    entry = product_campaigns.setdefault(
                        product_key,
                        {
                            "item_id": _row_value(row, "shopping_product.item_id"),
                            "resource_name": _row_value(
                                row, "shopping_product.resource_name"
                            ),
                            "status": _row_value(row, "shopping_product.status"),
                            "campaigns": {},
                        },
                    )
                    entry["campaigns"][str(campaign_id)] = {
                        "campaign_id": campaign_id,
                        "campaign_name": campaign_name,
                    }

    matching_products = [
        {
            "item_id": item["item_id"],
            "resource_name": item["resource_name"],
            "status": item["status"],
            "campaign_count": len(item["campaigns"]),
            "campaigns": list(item["campaigns"].values()),
        }
        for item in product_campaigns.values()
        if len(item["campaigns"]) >= final_min_campaign_count
    ]
    matching_products.sort(key=lambda item: item["campaign_count"], reverse=True)

    is_partial = (
        len(campaigns_to_scan) > processed_campaigns + len(skipped_campaigns)
        or timed_out_before_full_scan
    )
    result = {
        "customer_id": customer_id,
        "min_campaign_count": final_min_campaign_count,
        "campaign_status": campaign_status,
        "product_status_group": product_status_group,
        "campaigns_scanned": processed_campaigns,
        "campaigns_available": len(campaigns),
        "max_campaigns": final_max_campaigns or None,
        "campaign_scan_scope": (
            "all_available_campaigns"
            if final_max_campaigns == 0
            else "explicit_max_campaigns"
        ),
        "max_concurrency": final_max_concurrency,
        "time_budget_seconds": (
            final_time_budget_seconds if final_time_budget_seconds > 0 else None
        ),
        "elapsed_seconds": round(time.monotonic() - started_at, 2),
        "is_partial": is_partial,
        "partial_reason": (
            "time_budget_exceeded"
            if timed_out_before_full_scan
            else "some_campaigns_failed_or_unprocessed"
            if is_partial
            else None
        ),
        "campaigns_skipped": skipped_campaigns,
        "unique_products_scanned": len(product_campaigns),
        "product_campaign_pair_count": product_campaign_pair_count,
        "matching_product_count": len(matching_products),
        "samples": matching_products[:final_sample_size],
        "note": (
            "shopping_product.campaign requires an equality filter, so this "
            "tool decomposes the task into one valid campaign-scope query per "
            "campaign and compares product item IDs server-side. To avoid MCP "
            "timeouts, it scans Shopping and Performance Max campaigns in "
            "parallel batches, scans all available campaigns by default, caches "
            "complete repeated requests briefly, and returns partial results only "
            "if an explicit time budget is reached or individual campaign queries "
            "fail."
        ),
    }
    if not is_partial:
        _cache_set(
            _PRODUCT_CAMPAIGN_OVERLAP_CACHE,
            _PRODUCT_CAMPAIGN_OVERLAP_CACHE_LOCK,
            cache_key,
            result,
            _PRODUCT_CAMPAIGN_OVERLAP_CACHE_TTL_SECONDS,
        )
    return result


@mcp.tool()
def count_products_by_issue(
    customer_id: str,
    issue_text: str,
    status_group: str = "all",
    sample_size: int = 10,
) -> Dict[str, Any]:
    """Counts shopping products whose fetched issue details contain text.

    Use this when the user asks how many products have a specific Merchant
    Center / shopping product issue. `shopping_product.issues` is selectable
    but may not be filterable, so this tool fetches the issue field and counts
    matching rows server-side instead of refusing.

    Args:
        customer_id: The id of the customer
        issue_text: Text to match inside shopping_product.issues, e.g.
            "product page unavailable"
        status_group: Optional status group to prefilter products. Use all,
            eligible, limited, enabled, or not_eligible.
        sample_size: Number of matching product samples to return
    """

    final_sample_size = max(0, min(int(sample_size or 10), 25))
    conditions = _product_status_conditions(status_group)
    fields = [
        "shopping_product.resource_name",
        "shopping_product.item_id",
        "shopping_product.status",
        "shopping_product.issues",
    ]

    ga_service = utils.get_googleads_service("GoogleAdsService")
    query_parts = [f"SELECT {','.join(fields)} FROM shopping_product"]
    if conditions:
        query_parts.append(f" WHERE {' AND '.join(conditions)}")
    query_parts.append(" PARAMETERS omit_unselected_resource_names=true")
    query = "".join(query_parts)
    utils.logger.info(f"ads_mcp.count_products_by_issue query {query}")

    query_result = ga_service.search_stream(customer_id=customer_id, query=query)

    scanned_count = 0
    matched_count = 0
    samples = []
    issue_field = "shopping_product.issues"
    for batch in query_result:
        for row in batch.results:
            scanned_count += 1
            issues = utils.get_nested_attr(row, issue_field)
            if not _value_contains(issues, issue_text):
                continue

            matched_count += 1
            if len(samples) < final_sample_size:
                samples.append(
                    {
                        "resource_name": utils.format_output_value(
                            utils.get_nested_attr(row, "shopping_product.resource_name")
                        ),
                        "item_id": utils.format_output_value(
                            utils.get_nested_attr(row, "shopping_product.item_id")
                        ),
                        "status": utils.format_output_value(
                            utils.get_nested_attr(row, "shopping_product.status")
                        ),
                    }
                )

    return {
        "customer_id": customer_id,
        "issue_text": issue_text,
        "status_group": status_group,
        "query": query,
        "scanned_product_count": scanned_count,
        "matched_product_count": matched_count,
        "samples": samples,
        "note": (
            "shopping_product.issues was matched after fetching because the "
            "field may be selectable but not filterable in GAQL."
        ),
    }


@mcp.tool()
def account_metric_summary(
    customer_id: str,
    date_start: str,
    date_end: str,
    metrics: List[str],
) -> Dict[str, Any]:
    """Returns account-level metric totals for a finite date range.

    Args:
        customer_id: The id of the customer
        date_start: YYYY-MM-DD start date
        date_end: YYYY-MM-DD end date
        metrics: Metric aliases or full metrics.* fields
    """

    metric_fields = [_metric_field(metric) for metric in metrics]
    fields = [
        "customer.descriptive_name",
        "customer.currency_code",
        *metric_fields,
    ]
    rows = search(
        customer_id=customer_id,
        fields=fields,
        resource="customer",
        conditions=_date_range_conditions(date_start, date_end),
        limit=1,
    )
    row = rows[0] if rows else {}
    summary = {field: _row_value(row, field, 0) for field in metric_fields}
    if "metrics.cost_micros" in summary:
        summary["cost"] = _money_units(float(summary["metrics.cost_micros"] or 0))
    if "metrics.average_cpc" in summary:
        summary["average_cpc"] = _money_units(
            float(summary["metrics.average_cpc"] or 0)
        )
    return {
        "customer_id": customer_id,
        "account_name": _row_value(row, "customer.descriptive_name"),
        "currency_code": DEFAULT_CURRENCY_CODE,
        "date_start": date_start,
        "date_end": date_end,
        "metrics": summary,
    }


def _search_tool_description() -> str:
    """Returns the description for the `search` tool."""
    # Add a warning that will be part of the description
    file_content = (
        "WARNING: The list of valid resources is missing. "
        "Tool may not function correctly."
    )

    try:
        with open(utils.get_gaql_resources_filepath(), "r") as file:
            file_content = file.read()
    except FileNotFoundError:
        utils.logger.error("The specified file was not found.")

    return f"""
{search.__doc__}

### Hints
    Language Grammar can be found at https://developers.google.com/google-ads/api/docs/query/grammar
    All resources and descriptions are found at https://developers.google.com/google-ads/api/fields/v23/overview

    For Conversion issues try looking in offline_conversion_upload_conversion_action_summary

### Hint for customer_id
    should be a string of numbers without punctuation
    if presented in the form 123-456-7890 remove the hyphens and use 1234567890

### Hints for Dates
    All dates should be in the form YYYY-MM-DD and must include the dashes (-)
    Date literals from the Grammar must NEVER be used
    Date ranges should be finite and must include a start and end date

### Hints for limits
    Requests to resource change_event must specify a LIMIT of less than or equal to 10000
    For ranking, top/bottom, best/worst, or performance questions, do not use an unordered limited sample.
    Use ORDER BY on the ranking metric when asking for top-N by a specific metric.
    If the ranking requires multiple metrics or custom scoring, fetch the full candidate set with a large enough LIMIT and rank after fetching.
    For campaign performance ranking, add campaign.status = 'ENABLED' unless the user explicitly asks for all statuses.

### Hints for conversions questions
    https://developers.google.com/google-ads/api/docs/conversions/upload-summaries 


### Hints for all resources
    What follows is a list of valid resources that can be queried.
    To find out which specific fields you can select, filter by, or sort by for a given resource, you MUST use the `get_resource_metadata` tool.
    Do not guess the fields. Use the tool to look them up.
    Once you have the fields, ensure the whole field name is used (e.g., 'campaign.id', not just 'id'). Wildcards and partial fields are not allowed.
    {file_content}
"""


# The `search` tool requires a more complex description that's generated at
# runtime. Uses the `add_tool` method instead of an annnotation since `add_tool`
# provides the flexibility needed to generate the description while also
# including the `search` method's docstring.
mcp.add_tool(
    search,
    title="Fetches data from the Google Ads API using the search method",
    description=_search_tool_description(),
)
