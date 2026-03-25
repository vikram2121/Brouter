#!/usr/bin/env python3
"""
Price History Cache
Stores Polymarket price readings every 60 seconds.
Used for signal validation (what price was implied when agent posted?)
and price charts (showing market evolution over time).

Time-sensitive: Start collecting now to have 10 days history by April 1.
"""

import sqlite3
import time
from pathlib import Path
from typing import Optional
import structlog

log = structlog.get_logger("price_cache")

DB_PATH = Path("data/price_history.db")


def init_db():
    """Create price history table if it doesn't exist."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id TEXT NOT NULL,
                    condition_id TEXT NOT NULL,
                    implied_prob REAL NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    source TEXT DEFAULT 'polymarket'
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_condition_time
                ON price_history(condition_id, recorded_at)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_market_id
                ON price_history(market_id)
            """)
            conn.commit()
            log.info("price_cache.initialized", db_path=str(DB_PATH))
    except Exception as e:
        log.error("price_cache.init_failed", error=str(e))
        raise


def record_price(condition_id: str, market_id: str, implied_prob: float):
    """
    Store one price reading.
    Called every 60 seconds by oracle polling loop.
    
    Args:
        condition_id: Polymarket condition ID (e.g., "0xabc123...")
        market_id: Brouter market ID (internal key)
        implied_prob: Probability [0.0, 1.0]
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("""
                INSERT INTO price_history
                (market_id, condition_id, implied_prob, recorded_at, source)
                VALUES (?, ?, ?, ?, 'polymarket')
            """, (market_id, condition_id, implied_prob, int(time.time())))
            conn.commit()
        
        log.debug(
            "price_cache.recorded",
            condition_id=condition_id,
            market_id=market_id,
            implied_prob=implied_prob
        )
    except Exception as e:
        log.error(
            "price_cache.record_failed",
            condition_id=condition_id,
            error=str(e)
        )
        # Don't raise — allow polling to continue even if cache write fails


def get_price_at(condition_id: str, timestamp: int) -> Optional[float]:
    """
    Get the closest recorded price to a given timestamp.
    
    Used by signal validation:
    "What was the market pricing when this agent posted their signal?"
    
    Args:
        condition_id: Polymarket condition ID
        timestamp: Unix timestamp to query
        
    Returns:
        Implied probability [0.0, 1.0] if found, None if no price within 10 minutes
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute("""
                SELECT implied_prob, ABS(recorded_at - ?) as delta
                FROM price_history
                WHERE condition_id = ?
                ORDER BY delta ASC
                LIMIT 1
            """, (timestamp, condition_id)).fetchone()
        
        if row is None:
            log.debug("price_cache.no_price", condition_id=condition_id, timestamp=timestamp)
            return None
        
        implied_prob, delta = row
        
        # Reject if closest reading is more than 10 minutes away
        if delta > 600:
            log.debug(
                "price_cache.price_too_old",
                condition_id=condition_id,
                delta=delta,
                timestamp=timestamp
            )
            return None
        
        log.debug(
            "price_cache.price_found",
            condition_id=condition_id,
            implied_prob=implied_prob,
            delta=delta
        )
        return implied_prob
        
    except Exception as e:
        log.error("price_cache.get_price_failed", condition_id=condition_id, error=str(e))
        return None


def get_price_history(
    condition_id: str,
    from_ts: int,
    to_ts: int
) -> list:
    """
    Get all price readings for a market in a time range.
    Used for displaying price charts on market pages.
    
    Args:
        condition_id: Polymarket condition ID
        from_ts: Start timestamp (Unix)
        to_ts: End timestamp (Unix)
        
    Returns:
        List of (timestamp, implied_prob) tuples, ordered chronologically
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute("""
                SELECT recorded_at, implied_prob
                FROM price_history
                WHERE condition_id = ?
                AND recorded_at BETWEEN ? AND ?
                ORDER BY recorded_at ASC
            """, (condition_id, from_ts, to_ts)).fetchall()
        
        result = [(row[0], row[1]) for row in rows]
        log.debug(
            "price_cache.history_retrieved",
            condition_id=condition_id,
            count=len(result),
            from_ts=from_ts,
            to_ts=to_ts
        )
        return result
        
    except Exception as e:
        log.error("price_cache.get_history_failed", condition_id=condition_id, error=str(e))
        return []


def get_latest_price(condition_id: str) -> Optional[float]:
    """
    Get the most recent price reading for a market.
    
    Args:
        condition_id: Polymarket condition ID
        
    Returns:
        Implied probability [0.0, 1.0] if found, None if no history
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute("""
                SELECT implied_prob
                FROM price_history
                WHERE condition_id = ?
                ORDER BY recorded_at DESC
                LIMIT 1
            """, (condition_id,)).fetchone()
        
        if row is None:
            return None
        
        return row[0]
        
    except Exception as e:
        log.error("price_cache.get_latest_failed", condition_id=condition_id, error=str(e))
        return None


def purge_old_prices(days_to_keep: int = 90) -> int:
    """
    Remove price history older than N days.
    Run weekly — prevents unbounded DB growth.
    
    Args:
        days_to_keep: Retention period (default 90 days)
        
    Returns:
        Number of rows deleted
    """
    try:
        cutoff = int(time.time()) - (days_to_keep * 86400)
        
        with sqlite3.connect(DB_PATH) as conn:
            deleted = conn.execute(
                "DELETE FROM price_history WHERE recorded_at < ?",
                (cutoff,)
            ).rowcount
            conn.commit()
        
        log.info(
            "price_cache.purged",
            days_to_keep=days_to_keep,
            deleted_count=deleted
        )
        return deleted
        
    except Exception as e:
        log.error("price_cache.purge_failed", error=str(e))
        return 0


def get_cache_stats() -> dict:
    """
    Get statistics about the price cache.
    Used for monitoring/debugging.
    
    Returns:
        Dict with total records, date range, distinct markets
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            stats = conn.execute("""
                SELECT 
                    COUNT(*) as total_records,
                    COUNT(DISTINCT condition_id) as distinct_markets,
                    MIN(recorded_at) as earliest,
                    MAX(recorded_at) as latest
                FROM price_history
            """).fetchone()
        
        return {
            "total_records": stats[0] or 0,
            "distinct_markets": stats[1] or 0,
            "earliest_ts": stats[2],
            "latest_ts": stats[3],
            "db_size_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
        }
        
    except Exception as e:
        log.error("price_cache.stats_failed", error=str(e))
        return {}


if __name__ == "__main__":
    # Quick test
    init_db()
    
    # Record a test price
    record_price(
        condition_id="0xtest123",
        market_id="test-market-1",
        implied_prob=0.65
    )
    
    # Query it back
    price = get_latest_price("0xtest123")
    print(f"Latest price: {price}")
    
    # Get stats
    stats = get_cache_stats()
    print(f"Cache stats: {stats}")
