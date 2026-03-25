# data/feeds/polymarket.py
# Polymarket read-only price + resolution feed for Brouter
# No auth, no account, no cost — public Gamma API + CLOB API

import json
import time
import httpx
from py_clob_client.client import ClobClient
from dataclasses import dataclass
from typing import Optional
import structlog

log = structlog.get_logger()

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API  = "https://clob.polymarket.com"


@dataclass
class PolymarketPrice:
    condition_id:  str
    question:      str
    yes_token_id:  str
    no_token_id:   str
    implied_prob:  float   # 0.0 to 1.0 — probability of YES outcome
    spread:        float
    liquidity_usd: float
    volume_24h:    float
    ends_at:       str
    tags:          list


@dataclass
class PolymarketResolution:
    condition_id:      str
    resolved:          bool
    outcome:           Optional[str]  # "Yes" | "No" | None (note: capitalised)
    closed_time:       Optional[str]
    resolution_source: Optional[str]


def safe_get(url: str, params=None, retries: int = 3) -> dict:
    """Rate-limit-aware GET with exponential backoff."""
    for attempt in range(retries):
        resp = httpx.get(url, params=params)
        if resp.status_code == 429:
            wait = 2 ** attempt * 5  # 5, 10, 20 seconds
            log.warning("polymarket.rate_limited", wait=wait, url=url)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"polymarket: failed after {retries} retries: {url}")


class PolymarketFeed:

    def __init__(self):
        self.client = ClobClient(CLOB_API)  # no auth — read only

    def get_markets(self, min_liquidity: float = 10_000) -> list[PolymarketPrice]:
        """
        Pull active Polymarket markets suitable for Brouter.
        Filters: binary, min liquidity $10k, order book enabled.
        """
        markets = safe_get(
            f"{GAMMA_API}/markets",
            params={"active": "true", "closed": "false", "limit": 100}
        )
        result = []

        for m in markets:
            if m.get("liquidityNum", 0) < min_liquidity:
                continue

            token_ids = json.loads(m.get("clobTokenIds", "[]"))
            if len(token_ids) != 2:
                continue

            if not m.get("enableOrderBook"):
                continue

            yes_token, no_token = token_ids[0], token_ids[1]

            try:
                # CLOB methods return float or dict {price, spread, etc}
                mid_resp = self.client.get_midpoint(yes_token)
                bid_resp = self.client.get_price(yes_token, "BUY")
                ask_resp = self.client.get_price(yes_token, "SELL")
                
                # Handle both scalar and dict responses
                mid = float(mid_resp.get("mid") if isinstance(mid_resp, dict) else mid_resp or 0.5)
                bid = float(bid_resp.get("price") if isinstance(bid_resp, dict) else bid_resp or 0)
                ask = float(ask_resp.get("price") if isinstance(ask_resp, dict) else ask_resp or 1)
            except Exception as e:
                log.warning("polymarket.price_error",
                            condition_id=m.get("conditionId"), error=str(e))
                continue

            result.append(PolymarketPrice(
                condition_id  = m["conditionId"],
                question      = m["question"],
                yes_token_id  = yes_token,
                no_token_id   = no_token,
                implied_prob  = mid,
                spread        = ask - bid,
                liquidity_usd = m.get("liquidityNum", 0),
                volume_24h    = m.get("volume24hr", 0),
                ends_at       = m["endDateIso"],
                tags          = m.get("tags", []),
            ))

        log.info("polymarket.markets_fetched", count=len(result))
        return result

    def check_resolution(self, condition_id: str) -> PolymarketResolution:
        """
        Check if a Polymarket market has resolved.
        Called by oracle engine every 60s for markets in RESOLVING state.

        Note: outcome is capitalised — "Yes" or "No", not "yes"/"no".
        The oracle adapter normalises this to Outcome.YES / Outcome.NO.
        """
        m = safe_get(f"{GAMMA_API}/markets/{condition_id}")

        return PolymarketResolution(
            condition_id      = condition_id,
            resolved          = bool(m.get("resolved")),
            outcome           = m.get("outcome"),   # "Yes" | "No" | None
            closed_time       = m.get("closedTime"),
            resolution_source = m.get("resolutionSource"),
        )
