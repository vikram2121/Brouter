# oracle/adapters/polymarket.py
# Brouter oracle adapter — Polymarket CLOB markets
# Wraps PolymarketFeed.check_resolution() into the standard ResolutionEvent shape.

import time
from oracle.adapters.base import ResolutionEvent, Outcome
from data.feeds.polymarket import PolymarketFeed
import structlog

log = structlog.get_logger()

_feed = PolymarketFeed()


class PolymarketAdapter:
    """
    Resolves Brouter markets pegged to Polymarket CLOB markets.

    Oracle source format stored on Brouter market:
    {
        "provider":     "polymarket",
        "condition_id": "0xabc123...",
        "token_id":     "12345"        # YES token ID (for price display)
    }

    No API key needed. Resolution is fully public via Gamma API.
    Rate limits: ~5-10s between polls is safe. safe_get() handles 429s.
    """

    async def resolve(self, oracle_source: dict) -> ResolutionEvent:
        condition_id = oracle_source["condition_id"]
        source_url   = f"https://gamma-api.polymarket.com/markets/{condition_id}"

        resolution = _feed.check_resolution(condition_id)

        if not resolution.resolved:
            return ResolutionEvent(
                outcome     = Outcome.PENDING,
                resolved_at = 0,
                source_url  = source_url,
                source_data = {"resolved": False},
                confidence  = 0.0,
            )

        # Polymarket returns "Yes" or "No" (capitalised) — normalise
        raw = (resolution.outcome or "").strip().lower()
        if raw == "yes":
            outcome = Outcome.YES
        elif raw == "no":
            outcome = Outcome.NO
        else:
            log.warning("polymarket.unknown_outcome",
                        condition_id=condition_id, raw=raw)
            outcome = Outcome.VOID

        return ResolutionEvent(
            outcome     = outcome,
            resolved_at = int(time.time()),
            source_url  = source_url,
            source_data = {
                "resolved":          True,
                "outcome":           resolution.outcome,
                "closed_time":       resolution.closed_time,
                "resolution_source": resolution.resolution_source,
            },
            confidence  = 1.0,
        )
