#!/usr/bin/env python3
"""
Advance a market to a specific state.

Usage:
  python -m scripts.advance_market_state --market-id test_abc123 --state RESOLVING

Allowed transitions:
  PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
"""

import argparse
import sys
import os
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.connection import get_db_connection

# Valid state transitions
VALID_TRANSITIONS = {
    'PROPOSED': ['OPEN'],
    'OPEN': ['LOCKED', 'RESOLVING'],  # Can skip LOCKED for testing
    'LOCKED': ['RESOLVING'],
    'RESOLVING': ['SETTLED'],
    'SETTLED': ['ARCHIVED'],
    'ARCHIVED': []
}

def advance_market_state(market_id: str, target_state: str) -> dict:
    """Advance market to target state."""
    
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    try:
        # Get current market state
        cursor.execute("SELECT id, state FROM markets WHERE id = %s", (market_id,))
        market = cursor.fetchone()
        
        if not market:
            raise ValueError(f"Market not found: {market_id}")
        
        current_state = market['state']
        
        # Validate transition
        if target_state not in VALID_TRANSITIONS.get(current_state, []):
            raise ValueError(
                f"Invalid transition: {current_state} → {target_state}\n"
                f"Valid options: {VALID_TRANSITIONS.get(current_state, [])}"
            )
        
        now = datetime.utcnow()
        
        # Log state transition
        cursor.execute("""
            INSERT INTO market_state_log (
                marketId, fromState, toState, triggeredBy, loggedAt
            ) VALUES (%s, %s, %s, 'system', %s)
        """, (market_id, current_state, target_state, now))
        
        # Update market state
        state_field_map = {
            'OPEN': 'openedAt',
            'LOCKED': 'lockedAt',
            'RESOLVING': 'resolvingAt',
            'SETTLED': 'settledAt',
            'ARCHIVED': 'archivedAt'
        }
        
        field = state_field_map.get(target_state)
        if field:
            cursor.execute(
                f"UPDATE markets SET state = %s, {field} = %s, updatedAt = %s WHERE id = %s",
                (target_state, now, now, market_id)
            )
        
        conn.commit()
        
        return {
            'market_id': market_id,
            'from_state': current_state,
            'to_state': target_state,
            'transitioned_at': now.isoformat()
        }
        
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()

def main():
    parser = argparse.ArgumentParser(description='Advance market state')
    parser.add_argument('--market-id', required=True, help='Market ID')
    parser.add_argument('--state', required=True, help='Target state')
    
    args = parser.parse_args()
    
    try:
        result = advance_market_state(args.market_id, args.state)
        
        print(f"✅ State transition: {result['from_state']} → {result['to_state']}")
        print(f"   Market ID: {result['market_id']}")
        print(f"   Time: {result['transitioned_at']}")
        
    except ValueError as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
