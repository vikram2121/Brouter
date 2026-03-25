#!/usr/bin/env python3
"""Test OracleResolver in isolation (no DB, mocked feed)."""

import sys
import json
from datetime import datetime
from unittest.mock import Mock, patch
sys.path.insert(0, '/Users/VNRai/.openclaw/workspace/meridian-mvp')

from oracle.oracle import OracleResolver, DBConfig
from oracle.adapters.base import Outcome, ResolutionEvent
from data.feeds.polymarket import PolymarketResolution

print("=" * 70)
print("ORACLE RESOLVER TEST")
print("=" * 70)

# Test 1: Mock Polymarket feed
print("\n1. Testing resolution detection with mocked feed...")
try:
    mock_feed = Mock()
    
    # Scenario 1: Market resolved YES
    mock_feed.check_resolution.return_value = PolymarketResolution(
        condition_id="0x123abc",
        resolved=True,
        outcome="Yes",
        closed_time="2026-03-20T18:00:00Z",
        resolution_source="polymarket"
    )
    
    resolver = OracleResolver(feed=mock_feed)
    
    # Check the resolution
    event = resolver.check_market_resolution(
        market_id="market_1",
        condition_id="0x123abc",
        title="Sample Market"
    )
    
    assert event is not None, "Expected ResolutionEvent"
    assert event.outcome == Outcome.YES, f"Expected YES, got {event.outcome}"
    assert "polymarket" in event.source_url, f"Expected polymarket source"
    print(f"   ✓ YES outcome detected correctly: {event.outcome.value}")
    
except AssertionError as e:
    print(f"   ✗ {e}")
    sys.exit(1)
except Exception as e:
    print(f"   ✗ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 2: NO outcome
print("\n2. Testing NO outcome detection...")
try:
    mock_feed = Mock()
    mock_feed.check_resolution.return_value = PolymarketResolution(
        condition_id="0x456def",
        resolved=True,
        outcome="No",
        closed_time="2026-03-20T18:00:00Z",
        resolution_source="polymarket"
    )
    
    resolver = OracleResolver(feed=mock_feed)
    event = resolver.check_market_resolution(
        market_id="market_2",
        condition_id="0x456def",
        title="Another Market"
    )
    
    assert event.outcome == Outcome.NO, f"Expected NO, got {event.outcome}"
    print(f"   ✓ NO outcome detected correctly: {event.outcome.value}")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

# Test 3: Unresolved market
print("\n3. Testing unresolved market (returns None)...")
try:
    mock_feed = Mock()
    mock_feed.check_resolution.return_value = PolymarketResolution(
        condition_id="0x789ghi",
        resolved=False,
        outcome=None,
        closed_time=None,
        resolution_source=None
    )
    
    resolver = OracleResolver(feed=mock_feed)
    event = resolver.check_market_resolution(
        market_id="market_3",
        condition_id="0x789ghi",
        title="Not Yet Resolved"
    )
    
    assert event is None, f"Expected None for unresolved market, got {event}"
    print(f"   ✓ Unresolved market returns None")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

# Test 4: Resolved but no outcome (VOID)
print("\n4. Testing VOID outcome (resolved but no outcome)...")
try:
    mock_feed = Mock()
    mock_feed.check_resolution.return_value = PolymarketResolution(
        condition_id="0xaabbcc",
        resolved=True,
        outcome=None,
        closed_time="2026-03-20T18:00:00Z",
        resolution_source="polymarket"
    )
    
    resolver = OracleResolver(feed=mock_feed)
    event = resolver.check_market_resolution(
        market_id="market_4",
        condition_id="0xaabbcc",
        title="Voided Market"
    )
    
    assert event is not None, "Expected ResolutionEvent even for VOID"
    assert event.outcome == Outcome.VOID, f"Expected VOID, got {event.outcome}"
    print(f"   ✓ Resolved-but-no-outcome treated as VOID: {event.outcome.value}")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

# Test 5: API error handling
print("\n5. Testing error handling (API failure)...")
try:
    mock_feed = Mock()
    mock_feed.check_resolution.side_effect = Exception("API Error: 429 Too Many Requests")
    
    resolver = OracleResolver(feed=mock_feed)
    event = resolver.check_market_resolution(
        market_id="market_5",
        condition_id="0xdeadbe",
        title="Error Market"
    )
    
    assert event is None, f"Expected None on error, got {event}"
    print(f"   ✓ API errors handled gracefully (returns None)")
except Exception as e:
    print(f"   ✗ Unexpected error: {e}")
    sys.exit(1)

print("\n" + "=" * 70)
print("✓ ALL TESTS PASSED")
print("=" * 70)
print("\nOracleResolver behavior verified:")
print("  - YES/NO/VOID outcome detection ✓")
print("  - Unresolved market handling ✓")
print("  - Error handling (API failures) ✓")
print("  - ResolutionEvent structure ✓")
print("\nReady for database integration (Week 2)")
