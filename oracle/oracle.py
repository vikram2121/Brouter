#!/usr/bin/env python3
"""
OracleResolver: Polls Polymarket, detects resolutions, updates Brouter markets.

Workflow:
1. Query markets in RESOLVING state
2. Poll Polymarket for each market
3. If resolved: extract outcome
4. Update market_state_log with RESOLVED state
5. Trigger settlement (SettlementEngine in Week 3)
6. Respect rate limits (5-second delays between Polymarket queries)
"""

import time
import json
import sys
import os
from datetime import datetime, timedelta
from typing import Optional
from dataclasses import dataclass, field
import mysql.connector
import structlog
from dotenv import load_dotenv

# Load environment variables from .env FIRST, before anything else
load_dotenv()

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data.feeds.polymarket import PolymarketFeed
from data.price_cache import record_price, init_db as init_price_cache
from oracle.adapters.base import Outcome, ResolutionEvent

# Configure logging
log = structlog.get_logger("oracle.resolver")


@dataclass
class DBConfig:
    """MySQL connection config."""
    host: str = field(default_factory=lambda: os.getenv('DB_HOST', 'localhost'))
    user: str = field(default_factory=lambda: os.getenv('DB_USER', 'root'))
    password: str = field(default_factory=lambda: os.getenv('DB_PASSWORD', ''))
    database: str = field(default_factory=lambda: os.getenv('DB_NAME', 'scout'))


class OracleResolver:
    """
    Main oracle polling engine. Queries Polymarket, detects resolutions,
    updates Brouter database with outcomes.
    """

    def __init__(self, db_config: DBConfig = None, feed: PolymarketFeed = None):
        self.db_config = db_config or DBConfig()
        self.feed = feed or PolymarketFeed()
        self.conn = None
        self.last_poll_time = None
        self.poll_interval_seconds = 60
        self.rate_limit_delay = 5  # seconds between Polymarket queries
        
        # Initialize price cache on startup
        try:
            init_price_cache()
        except Exception as e:
            log.warning("oracle.price_cache_init_failed", error=str(e))

    def connect_db(self):
        """Establish MySQL connection."""
        try:
            self.conn = mysql.connector.connect(
                host=self.db_config.host,
                user=self.db_config.user,
                password=self.db_config.password,
                database=self.db_config.database
            )
            log.info("db.connected", host=self.db_config.host, database=self.db_config.database)
        except Exception as e:
            log.error("db.connection_failed", error=str(e))
            raise

    def disconnect_db(self):
        """Close MySQL connection."""
        if self.conn:
            self.conn.close()
            log.info("db.disconnected")

    def get_resolving_markets(self) -> list:
        """
        Query markets in RESOLVING state that haven't been checked recently.
        Returns: list of {id, condition_id, title, last_checked}
        """
        try:
            cursor = self.conn.cursor(dictionary=True)
            cursor.execute("""
                SELECT 
                    id, 
                    title,
                    conditionId,
                    resolvesAt,
                    COALESCE(lastOracleCheck, '1970-01-01') as lastOracleCheck
                FROM markets
                WHERE state = 'RESOLVING'
                  AND conditionId IS NOT NULL
                  AND (lastOracleCheck IS NULL OR lastOracleCheck < DATE_SUB(NOW(), INTERVAL 30 SECOND))
                ORDER BY lastOracleCheck ASC
                LIMIT 50
            """)
            markets = cursor.fetchall()
            cursor.close()
            
            log.info("markets.query_resolving", count=len(markets))
            return markets
        except Exception as e:
            log.error("markets.query_failed", error=str(e))
            return []

    def check_market_resolution(self, market_id: str, condition_id: str, title: str) -> Optional[ResolutionEvent]:
        """
        Poll Polymarket for a specific market.
        Caches price and returns ResolutionEvent if resolved, None otherwise.
        """
        try:
            time.sleep(self.rate_limit_delay)  # Rate limit
            
            # Get price and cache it (for signal validation + charts)
            try:
                price_data = self.feed.get_price(condition_id)
                if price_data and hasattr(price_data, 'implied_prob'):
                    record_price(
                        condition_id=condition_id,
                        market_id=market_id,
                        implied_prob=price_data.implied_prob
                    )
            except Exception as e:
                log.debug("oracle.price_cache_failed", market_id=market_id, error=str(e))
                # Continue even if caching fails
            
            resolution = self.feed.check_resolution(condition_id)
            
            if not resolution.resolved:
                log.debug("market_not_resolved", market_id=market_id, condition_id=condition_id)
                return None
            
            if not resolution.outcome:
                log.warning("market_resolved_no_outcome", market_id=market_id, condition_id=condition_id)
                # Market resolved but outcome is None — treat as VOID
                outcome = Outcome.VOID
            else:
                # outcome is "Yes" or "No" (capitalised from Polymarket)
                outcome = Outcome.YES if resolution.outcome.lower() == "yes" else Outcome.NO
            
            # Parse closed_time as Unix timestamp
            try:
                closed_dt = datetime.fromisoformat(resolution.closed_time.replace('Z', '+00:00'))
                resolved_at = int(closed_dt.timestamp())
            except:
                resolved_at = int(datetime.utcnow().timestamp())
            
            event = ResolutionEvent(
                outcome=outcome,
                resolved_at=resolved_at,
                source_url=f"https://gamma-api.polymarket.com/markets/{condition_id}",
                source_data={
                    "condition_id": condition_id,
                    "resolution_source": resolution.resolution_source,
                    "title": title,
                    "market_id": market_id
                },
                confidence=1.0  # Polymarket is authoritative
            )
            
            log.info(
                "market_resolved",
                market_id=market_id,
                outcome=outcome.value,
                source="polymarket"
            )
            return event
        except Exception as e:
            log.warning("market_check_failed", market_id=market_id, error=str(e))
            return None

    def update_market_state(self, market_id: str, outcome: Outcome, oracle_source: str = "polymarket"):
        """
        Update market_state_log with RESOLVED outcome.
        Triggered by oracle detection.
        
        Note: Settlement is handled by SettlementEngine (Week 3).
        This just logs the resolution.
        """
        try:
            cursor = self.conn.cursor()
            
            # Log the state transition: RESOLVING → RESOLVED
            cursor.execute("""
                INSERT INTO market_state_log 
                (marketId, toState, triggeredBy, loggedAt, oracleOutcome, oracleSource)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                market_id,
                "RESOLVING",  # Current state before transition
                "oracle",
                datetime.utcnow(),
                outcome.value,
                oracle_source
            ))
            
            # Update market with resolved outcome
            cursor.execute("""
                UPDATE markets
                SET 
                    state = 'RESOLVING',
                    resolvedOutcome = %s,
                    oracleSource = %s,
                    lastOracleCheck = NOW()
                WHERE id = %s
            """, (outcome.value, oracle_source, market_id))
            
            self.conn.commit()
            log.info("market.state_logged", market_id=market_id, outcome=outcome.value)
        except Exception as e:
            log.error("market.state_update_failed", market_id=market_id, error=str(e))
            self.conn.rollback()

    def poll_once(self) -> int:
        """
        Single polling cycle.
        Returns: number of markets resolved
        """
        try:
            markets = self.get_resolving_markets()
            if not markets:
                log.debug("poll.no_markets_to_check")
                return 0
            
            resolved_count = 0
            for market in markets:
                resolution = self.check_market_resolution(
                    market_id=market["id"],
                    condition_id=market["conditionId"],
                    title=market["title"]
                )
                
                if resolution:
                    self.update_market_state(
                        market_id=market["id"],
                        outcome=resolution.outcome,
                        oracle_source="polymarket"
                    )
                    resolved_count += 1
            
            self.last_poll_time = datetime.utcnow()
            log.info("poll.cycle_complete", markets_checked=len(markets), markets_resolved=resolved_count)
            return resolved_count
        except Exception as e:
            log.error("poll.failed", error=str(e))
            return 0

    def run_loop(self, duration_seconds: Optional[int] = None):
        """
        Continuous polling loop. Runs indefinitely or for specified duration.
        
        Args:
            duration_seconds: If set, stop after this many seconds. Useful for testing.
        """
        try:
            self.connect_db()
            start_time = datetime.utcnow()
            
            log.info("oracle.started", interval_seconds=self.poll_interval_seconds)
            
            while True:
                try:
                    self.poll_once()
                    time.sleep(self.poll_interval_seconds)
                    
                    if duration_seconds:
                        elapsed = (datetime.utcnow() - start_time).total_seconds()
                        if elapsed >= duration_seconds:
                            log.info("oracle.stopping", duration_seconds=duration_seconds)
                            break
                except KeyboardInterrupt:
                    log.info("oracle.interrupted")
                    break
                except Exception as e:
                    log.error("oracle.error", error=str(e))
                    time.sleep(self.poll_interval_seconds)
        finally:
            self.disconnect_db()

    def run_once(self):
        """Single poll cycle (for testing)."""
        try:
            self.connect_db()
            count = self.poll_once()
            return count
        finally:
            self.disconnect_db()


def main():
    """CLI entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Brouter Oracle Resolver")
    parser.add_argument("--host", default=os.getenv('DB_HOST', 'localhost'), help="MySQL host")
    parser.add_argument("--user", default=os.getenv('DB_USER', 'root'), help="MySQL user")
    parser.add_argument("--password", default=os.getenv('DB_PASSWORD', ''), help="MySQL password")
    parser.add_argument("--database", default=os.getenv('DB_NAME', 'scout'), help="MySQL database")
    parser.add_argument("--duration", type=int, help="Run for N seconds (test mode)")
    parser.add_argument("--once", action="store_true", help="Poll once and exit")
    
    args = parser.parse_args()
    
    config = DBConfig(
        host=args.host,
        user=args.user,
        password=args.password,
        database=args.database
    )
    
    resolver = OracleResolver(db_config=config)
    
    if args.once:
        count = resolver.run_once()
        print(f"Polled 1 cycle, resolved {count} markets")
    else:
        resolver.run_loop(duration_seconds=args.duration)


if __name__ == "__main__":
    main()
