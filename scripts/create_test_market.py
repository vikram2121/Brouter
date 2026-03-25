#!/usr/bin/env python3
"""
Create a test market for smoke testing.

Usage:
  python -m scripts.create_test_market --question "Test question?" --condition-id cond-001

Creates a market in PROPOSED state and immediately opens it (OPEN).
Readies market for staking.
"""

import argparse
import sys
import os
from datetime import datetime, timedelta
import uuid

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.connection import get_db_connection

def create_test_market(question: str, condition_id: str) -> dict:
    """Create a test market and immediately open it."""
    
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    try:
        market_id = f"test_{uuid.uuid4().hex[:12]}"
        now = datetime.utcnow()
        
        # Market closes in 48 hours (minimum duration)
        closes_at = now + timedelta(hours=48)
        resolves_at = closes_at + timedelta(minutes=1)
        
        # Create market in PROPOSED state
        cursor.execute("""
            INSERT INTO markets (
                id, title, description, domain, tier,
                state, proposedAt,
                closesAt, resolvesAt,
                minDurationHours, lockMinutesBeforeClose,
                resolutionCriteria,
                oracleProvider, conditionId,
                minStakeToOpenSats,
                createdAt, updatedAt
            ) VALUES (
                %s, %s, %s, %s, %s,
                'PROPOSED', %s,
                %s, %s,
                48, 60,
                %s,
                'polymarket', %s,
                0,
                %s, %s
            )
        """, (
            market_id,
            question,
            f"Test market: {question}",
            'crypto',
            'weekly',
            now,
            closes_at,
            resolves_at,
            question,
            condition_id,
            now,
            now
        ))
        
        # Transition to OPEN state
        cursor.execute("""
            INSERT INTO market_state_log (
                marketId, fromState, toState, triggeredBy, loggedAt
            ) VALUES (%s, 'PROPOSED', 'OPEN', 'system', %s)
        """, (market_id, now))
        
        cursor.execute("""
            UPDATE markets
            SET state = 'OPEN', openedAt = %s, updatedAt = %s
            WHERE id = %s
        """, (now, now, market_id))
        
        conn.commit()
        
        return {
            'market_id': market_id,
            'state': 'OPEN',
            'condition_id': condition_id,
            'closes_at': closes_at.isoformat(),
            'resolves_at': resolves_at.isoformat()
        }
        
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()

def main():
    parser = argparse.ArgumentParser(description='Create a test market')
    parser.add_argument('--question', required=True, help='Market question')
    parser.add_argument('--condition-id', required=True, help='Oracle condition ID (e.g., test-001)')
    
    args = parser.parse_args()
    
    result = create_test_market(args.question, args.condition_id)
    
    print(f"✅ Market created: {result['market_id']}")
    print(f"   Question: {args.question}")
    print(f"   State: {result['state']}")
    print(f"   Condition ID: {result['condition_id']}")
    print(f"   Closes: {result['closes_at']}")
    print(f"   Resolves: {result['resolves_at']}")

if __name__ == '__main__':
    main()
