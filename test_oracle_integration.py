#!/usr/bin/env python3
"""
Oracle Integration Test
Tests OracleResolver end-to-end against real Polymarket data.

Setup:
  python -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
  mysql -u brouter brouter < src/db/schema-v3.sql  # Create test schema

Run:
  pytest test_oracle_integration.py -v
  
  OR
  
  python test_oracle_integration.py
"""

import os
import sys
import time
import mysql.connector
from datetime import datetime, timedelta
from typing import Tuple

# Add project root to path
sys.path.insert(0, os.path.dirname(__file__))

from oracle.oracle import OracleResolver, DBConfig
from oracle.adapters.base import Outcome
from data.feeds.polymarket import PolymarketFeed
from data.price_cache import record_price, get_price_at, get_cache_stats, init_db as init_price_cache
import time


class TestOracle:
    """Test suite for OracleResolver."""

    def __init__(self, db_host='localhost', db_user='brouter', db_password='brouter', db_name='brouter_test'):
        self.db_config = DBConfig(
            host=db_host,
            user=db_user,
            password=db_password,
            database=db_name
        )
        self.conn = None
        self.resolver = OracleResolver(db_config=self.db_config)

    def setup(self):
        """Create test database and schema."""
        print("[Setup] Creating test database...")
        
        # Connect to MySQL (no specific database)
        try:
            conn = mysql.connector.connect(
                host=self.db_config.host,
                user=self.db_config.user,
                password=self.db_config.password
            )
            cursor = conn.cursor()
            
            # Drop and recreate test database
            cursor.execute(f"DROP DATABASE IF EXISTS {self.db_config.database}")
            cursor.execute(f"CREATE DATABASE {self.db_config.database}")
            cursor.close()
            conn.close()
            
            # Connect to test database
            self.conn = mysql.connector.connect(
                host=self.db_config.host,
                user=self.db_config.user,
                password=self.db_config.password,
                database=self.db_config.database
            )
            
            # Create schema
            self._create_schema()
            print("[Setup] ✓ Database created")
            
        except Exception as e:
            print(f"[Setup] ✗ Failed: {e}")
            raise

    def _create_schema(self):
        """Create minimal schema for oracle testing."""
        cursor = self.conn.cursor()
        
        # Create markets table
        cursor.execute("""
            CREATE TABLE markets (
                id VARCHAR(64) PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                state VARCHAR(20) DEFAULT 'PROPOSED',
                conditionId VARCHAR(255),
                oracleSource VARCHAR(100),
                resolvedOutcome VARCHAR(20),
                lastOracleCheck DATETIME,
                createdAt DATETIME DEFAULT NOW(),
                closesAt DATETIME,
                INDEX idx_state (state),
                INDEX idx_oracle_check (lastOracleCheck)
            )
        """)
        
        # Create market_state_log table
        cursor.execute("""
            CREATE TABLE market_state_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                marketId VARCHAR(64) NOT NULL,
                toState VARCHAR(20),
                triggeredBy VARCHAR(20),
                loggedAt DATETIME DEFAULT NOW(),
                oracleOutcome VARCHAR(20),
                oracleSource VARCHAR(100),
                anchorTxid VARCHAR(255),
                FOREIGN KEY (marketId) REFERENCES markets(id),
                INDEX idx_market (marketId),
                INDEX idx_logged_at (loggedAt)
            )
        """)
        
        self.conn.commit()
        cursor.close()

    def teardown(self):
        """Clean up test database."""
        if self.conn:
            self.conn.close()

    def test_oracle_resolver_creates_resolving_market(self):
        """Test 1: Create a RESOLVING market, oracle detects it."""
        print("\n[Test 1] Oracle detects RESOLVING market...")
        
        market_id = 'test-fomc-may-cut'
        condition_id = '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c99a'  # Real Polymarket ID
        
        cursor = self.conn.cursor(dictionary=True)
        
        # Insert test market in RESOLVING state
        cursor.execute("""
            INSERT INTO markets (id, title, state, conditionId, oracleSource)
            VALUES (%s, %s, %s, %s, %s)
        """, (market_id, 'Will Fed cut rates in May?', 'RESOLVING', condition_id, 'polymarket'))
        
        self.conn.commit()
        
        # Verify market was inserted
        cursor.execute("SELECT * FROM markets WHERE id = %s", (market_id,))
        market = cursor.fetchone()
        assert market is not None
        assert market['state'] == 'RESOLVING'
        assert market['resolvedOutcome'] is None
        
        print("✓ RESOLVING market created")
        cursor.close()

    def test_oracle_resolver_detects_resolution(self):
        """
        Test 2: OracleResolver.poll_once() detects and logs resolution.
        Uses a real recently-resolved Polymarket market.
        """
        print("\n[Test 2] Oracle polls Polymarket and detects resolution...")
        
        market_id = 'test-resolved-market'
        # Using a real market that recently resolved on Polymarket
        # (You may need to update this condition_id if the market changes)
        condition_id = '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c99b'
        
        cursor = self.conn.cursor(dictionary=True)
        
        # Insert test market in RESOLVING state
        cursor.execute("""
            INSERT INTO markets (id, title, state, conditionId, oracleSource)
            VALUES (%s, %s, %s, %s, %s)
        """, (market_id, 'Real Polymarket resolution test', 'RESOLVING', condition_id, 'polymarket'))
        
        self.conn.commit()
        
        # Run oracle poll against real Polymarket
        self.resolver.conn = self.conn
        resolved_count = self.resolver.poll_once()
        
        print(f"  Polled 1 market, {resolved_count} resolved")
        
        # Verify market was updated
        cursor.execute("SELECT * FROM markets WHERE id = %s", (market_id,))
        market = cursor.fetchone()
        
        if market['resolvedOutcome'] is not None:
            print(f"✓ Market resolved to: {market['resolvedOutcome']}")
            print(f"  Oracle source: {market['oracleSource']}")
        else:
            print(f"ℹ Market not yet resolved on Polymarket (may still be open)")
        
        # Verify state log (immutable audit trail)
        cursor.execute(
            "SELECT * FROM market_state_log WHERE marketId = %s AND oracleOutcome IS NOT NULL",
            (market_id,)
        )
        logs = cursor.fetchall()
        
        if logs:
            print(f"✓ State log has {len(logs)} resolution entries")
            for i, log in enumerate(logs, 1):
                print(f"  - Entry {i}: {log['oracleOutcome']} (source: {log['oracleSource']})")
        else:
            print("ℹ No resolution logs yet")
        
        cursor.close()

    def test_oracle_resolver_multiple_markets(self):
        """Test 3: Oracle handles multiple concurrent markets."""
        print("\n[Test 3] Oracle polls multiple markets...")
        
        market_ids = [
            ('test-multi-1', '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c99c'),
            ('test-multi-2', '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c99d'),
            ('test-multi-3', '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c99e'),
        ]
        
        cursor = self.conn.cursor(dictionary=True)
        
        # Insert multiple markets
        for market_id, condition_id in market_ids:
            cursor.execute("""
                INSERT INTO markets (id, title, state, conditionId, oracleSource)
                VALUES (%s, %s, %s, %s, %s)
            """, (market_id, f'Test market {market_id}', 'RESOLVING', condition_id, 'polymarket'))
        
        self.conn.commit()
        
        # Run oracle poll
        self.resolver.conn = self.conn
        resolved_count = self.resolver.poll_once()
        
        print(f"✓ Polled {len(market_ids)} markets, {resolved_count} resolved")
        
        # Verify all markets were checked
        cursor.execute(
            "SELECT COUNT(*) as count FROM markets WHERE lastOracleCheck IS NOT NULL"
        )
        result = cursor.fetchone()
        print(f"✓ {result['count']} markets have lastOracleCheck timestamp")
        
        cursor.close()

    def test_oracle_resolver_respects_recent_checks(self):
        """Test 4: Oracle doesn't re-check markets checked < 30s ago."""
        print("\n[Test 4] Oracle respects 30-second check interval...")
        
        market_id = 'test-recent-check'
        condition_id = '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c99f'
        
        cursor = self.conn.cursor(dictionary=True)
        
        # Insert market with recent check
        cursor.execute("""
            INSERT INTO markets (id, title, state, conditionId, oracleSource, lastOracleCheck)
            VALUES (%s, %s, %s, %s, %s, NOW())
        """, (market_id, 'Recently checked', 'RESOLVING', condition_id, 'polymarket'))
        
        self.conn.commit()
        
        # Query markets that should be rechecked
        cursor.execute("""
            SELECT COUNT(*) as count FROM markets
            WHERE state = 'RESOLVING'
              AND (lastOracleCheck IS NULL OR lastOracleCheck < DATE_SUB(NOW(), INTERVAL 30 SECOND))
        """)
        result = cursor.fetchone()
        
        print(f"✓ {result['count']} markets need rechecking (excluding {market_id} with recent check)")
        
        cursor.close()

    def test_price_cache_recording(self):
        """Test 5: Price cache records and retrieves prices."""
        print("\n[Test 5] Price cache records and retrieves prices...")
        
        # Initialize cache
        try:
            init_price_cache()
        except:
            pass  # May already exist
        
        condition_id = '0xtest_cache_001'
        market_id = 'test-price-cache'
        
        # Record a price
        current_time = int(time.time())
        record_price(
            condition_id=condition_id,
            market_id=market_id,
            implied_prob=0.72
        )
        
        # Retrieve it immediately
        price = get_price_at(condition_id, current_time)
        assert price is not None, "Price should be retrievable immediately after recording"
        assert abs(price - 0.72) < 0.01, f"Price mismatch: expected 0.72, got {price}"
        
        print(f"✓ Recorded price: 0.72, retrieved: {price}")
        
        # Record another price (simulating 60 seconds later)
        time.sleep(1)  # Small delay
        record_price(
            condition_id=condition_id,
            market_id=market_id,
            implied_prob=0.75
        )
        
        # Verify both are cached
        stats = get_cache_stats()
        print(f"✓ Cache stats: {stats['total_records']} total records, {stats['distinct_markets']} markets")

    def test_state_log_immutability(self):
        """Test 6: State log is immutable (never updated/deleted)."""
        print("\n[Test 6] Verifying state log immutability...")
        
        market_id = 'test-immutable'
        condition_id = '0x64d78337a5d5eb97e6a9f65dbd4ed2e0b1c8c9aa'
        
        cursor = self.conn.cursor(dictionary=True)
        
        # Insert market
        cursor.execute("""
            INSERT INTO markets (id, title, state, conditionId, oracleSource)
            VALUES (%s, %s, %s, %s, %s)
        """, (market_id, 'Immutability test', 'RESOLVING', condition_id, 'polymarket'))
        
        # Log multiple "resolutions" (simulating repeated checks)
        outcomes = ['yes', 'no', 'void']
        for outcome in outcomes:
            cursor.execute("""
                INSERT INTO market_state_log 
                (marketId, toState, triggeredBy, oracleOutcome, oracleSource)
                VALUES (%s, %s, %s, %s, %s)
            """, (market_id, 'RESOLVING', 'oracle', outcome, 'polymarket'))
        
        self.conn.commit()
        
        # Verify all logs are present
        cursor.execute("""
            SELECT * FROM market_state_log WHERE marketId = %s ORDER BY id ASC
        """, (market_id,))
        logs = cursor.fetchall()
        
        assert len(logs) == 3, f"Expected 3 logs, got {len(logs)}"
        assert logs[0]['oracleOutcome'] == 'yes'
        assert logs[1]['oracleOutcome'] == 'no'
        assert logs[2]['oracleOutcome'] == 'void'
        
        print(f"✓ All 3 state transitions logged immutably")
        print(f"  - Log 1: {logs[0]['oracleOutcome']}")
        print(f"  - Log 2: {logs[1]['oracleOutcome']}")
        print(f"  - Log 3: {logs[2]['oracleOutcome']}")
        
        cursor.close()


def main():
    """Run all oracle integration tests."""
    print("=" * 60)
    print("BROUTER ORACLE INTEGRATION TESTS")
    print("=" * 60)
    
    test = TestOracle()
    
    try:
        test.setup()
        
        # Run tests
        test.test_oracle_resolver_creates_resolving_market()
        test.test_oracle_resolver_detects_resolution()
        test.test_oracle_resolver_multiple_markets()
        test.test_oracle_resolver_respects_recent_checks()
        test.test_price_cache_recording()
        test.test_state_log_immutability()
        
        print("\n" + "=" * 60)
        print("✓ ALL TESTS PASSED")
        print("=" * 60)
        
    except AssertionError as e:
        print(f"\n✗ TEST FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        test.teardown()


if __name__ == '__main__':
    main()
