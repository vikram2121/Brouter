#!/usr/bin/env python3
"""
Check market state and outcome.

Usage:
  python -m scripts.check_market --market-id test_abc123

Displays:
  - Market state (PROPOSED, OPEN, LOCKED, RESOLVING, SETTLED, ARCHIVED)
  - Outcome (yes, no, void, NULL)
  - Stake totals (yes/no)
  - State log (audit trail)
"""

import argparse
import sys
import os
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.connection import get_db_connection

def check_market(market_id: str) -> dict:
    """Check market state and details."""
    
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    try:
        # Get market details
        cursor.execute("""
            SELECT
                id, title, state, outcome,
                totalYesSats, totalNoSats, agentCount,
                proposedAt, openedAt, lockedAt, resolvingAt, settledAt,
                closesAt, resolvesAt
            FROM markets
            WHERE id = %s
        """, (market_id,))
        
        market = cursor.fetchone()
        if not market:
            raise ValueError(f"Market not found: {market_id}")
        
        # Get state log
        cursor.execute("""
            SELECT fromState, toState, triggeredBy, loggedAt
            FROM market_state_log
            WHERE marketId = %s
            ORDER BY loggedAt ASC
        """, (market_id,))
        
        state_log = cursor.fetchall()
        
        # Get stakes
        cursor.execute("""
            SELECT
                direction,
                COUNT(*) as count,
                SUM(amountSats) as total_sats
            FROM stakes
            WHERE marketId = %s
            GROUP BY direction
        """, (market_id,))
        
        stakes = cursor.fetchall()
        
        return {
            'market': market,
            'state_log': state_log,
            'stakes': stakes
        }
        
    finally:
        cursor.close()
        conn.close()

def main():
    parser = argparse.ArgumentParser(description='Check market state')
    parser.add_argument('--market-id', required=True, help='Market ID')
    
    args = parser.parse_args()
    
    try:
        result = check_market(args.market_id)
        market = result['market']
        
        print(f"\n{'=' * 60}")
        print(f"MARKET: {market['title']}")
        print(f"ID: {market['id']}")
        print(f"{'=' * 60}")
        
        print(f"\n📊 CURRENT STATE: {market['state']}")
        if market['outcome']:
            print(f"   Outcome: {market['outcome'].upper()}")
        
        print(f"\n💰 STAKES:")
        print(f"   YES:  {market['totalYesSats']:,} sats")
        print(f"   NO:   {market['totalNoSats']:,} sats")
        print(f"   Agents: {market['agentCount']}")
        
        print(f"\n⏰ TIMELINE:")
        print(f"   Proposed:  {market['proposedAt']}")
        print(f"   Opened:    {market['openedAt']}")
        print(f"   Locked:    {market['lockedAt']}")
        print(f"   Resolving: {market['resolvingAt']}")
        print(f"   Settled:   {market['settledAt']}")
        print(f"   Closes:    {market['closesAt']}")
        print(f"   Resolves:  {market['resolvesAt']}")
        
        print(f"\n📜 STATE LOG:")
        for i, entry in enumerate(result['state_log'], 1):
            from_state = entry['fromState'] or 'INIT'
            print(f"   {i}. {from_state} → {entry['toState']}")
            print(f"      Triggered by: {entry['triggeredBy']}")
            print(f"      Time: {entry['loggedAt']}")
        
        print(f"\n{'=' * 60}\n")
        
    except ValueError as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
