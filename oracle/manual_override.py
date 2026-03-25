#!/usr/bin/env python3
"""
Manual Oracle Override
Force a market to resolve for testing purposes (settlement testing, dry runs).

SAFETY: Only works in testnet/dry-run mode.
Never callable on BSV mainnet — raises PermissionError.

Usage:
    python -m oracle.manual_override --market-id abc123 --outcome yes --reason "integration_test"
"""

import argparse
import os
import sys
import mysql.connector
from datetime import datetime
import structlog
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

log = structlog.get_logger("oracle.manual_override")


class ManualOracle:
    """Force market resolutions for testing."""
    
    def __init__(self, db_host=None, db_user=None, db_password=None, db_name=None):
        self.db_host = db_host or os.getenv('DB_HOST', 'localhost')
        self.db_user = db_user or os.getenv('DB_USER', 'root')
        self.db_password = db_password or os.getenv('DB_PASSWORD', '')
        self.db_name = db_name or os.getenv('DB_NAME', 'scout')
        
        # Safety check: dry_run must be enabled
        self.dry_run = os.getenv('BROUTER_DRY_RUN', 'false').lower() == 'true'
        self.network = os.getenv('BSV_NETWORK', 'testnet')
    
    def _check_safety(self):
        """Ensure manual override is only used in safe environments."""
        if not self.dry_run:
            raise PermissionError(
                "Manual oracle override requires BROUTER_DRY_RUN=true environment variable. "
                "This prevents accidental market manipulation on production."
            )
        
        if self.network == 'mainnet':
            raise PermissionError(
                "Manual oracle override is NOT allowed on BSV mainnet. "
                f"Current network: {self.network}"
            )
        
        log.warning(
            "oracle.manual_override.safety_check_passed",
            dry_run=self.dry_run,
            network=self.network
        )
    
    def force_resolve(self, market_id: str, outcome: str, reason: str = "manual_test"):
        """
        Force a market to resolve immediately.
        
        Args:
            market_id: Brouter market ID
            outcome: "yes" | "no" | "void"
            reason: Why this override (for audit logging)
        """
        # Safety check
        self._check_safety()
        
        # Validate outcome
        if outcome not in ['yes', 'no', 'void']:
            raise ValueError(f"Invalid outcome: {outcome}. Must be 'yes', 'no', or 'void'.")
        
        try:
            conn = mysql.connector.connect(
                host=self.db_host,
                user=self.db_user,
                password=self.db_password,
                database=self.db_name
            )
            cursor = conn.cursor(dictionary=True)
            
            # Verify market exists
            cursor.execute("SELECT * FROM markets WHERE id = %s", (market_id,))
            market = cursor.fetchone()
            
            if not market:
                log.error("oracle.manual_override.market_not_found", market_id=market_id)
                raise ValueError(f"Market {market_id} not found in database.")
            
            # Update market to SETTLED with outcome
            cursor.execute("""
                UPDATE markets
                SET 
                    state = 'SETTLED',
                    outcome = %s,
                    settledAt = NOW(),
                    updatedAt = NOW()
                WHERE id = %s
            """, (outcome, market_id))
            
            # Log the state transition (immutable audit trail): RESOLVING → SETTLED
            cursor.execute("""
                INSERT INTO market_state_log 
                (marketId, fromState, toState, triggeredBy, loggedAt)
                VALUES (%s, 'RESOLVING', 'SETTLED', 'manual_override', NOW())
            """, (market_id,))
            
            conn.commit()
            cursor.close()
            conn.close()
            
            log.warning(
                "oracle.manual_override.market_resolved",
                market_id=market_id,
                outcome=outcome,
                reason=reason,
                network=self.network,
                dry_run=self.dry_run
            )
            
            print(f"✓ Market {market_id} forced to outcome: {outcome}")
            print(f"  Reason: {reason}")
            print(f"  Network: {self.network}")
            print(f"  State logged in market_state_log")
            
        except Exception as e:
            log.error("oracle.manual_override.failed", market_id=market_id, error=str(e))
            raise
    
    def list_unresolved(self):
        """List all markets in RESOLVING state (candidates for manual resolution)."""
        try:
            conn = mysql.connector.connect(
                host=self.db_host,
                user=self.db_user,
                password=self.db_password,
                database=self.db_name
            )
            cursor = conn.cursor(dictionary=True)
            
            cursor.execute("""
                SELECT id, title, state, resolvedOutcome, closesAt
                FROM markets
                WHERE state = 'RESOLVING'
                ORDER BY closesAt ASC
            """)
            
            markets = cursor.fetchall()
            cursor.close()
            conn.close()
            
            if not markets:
                print("No markets in RESOLVING state.")
                return
            
            print(f"\n{len(markets)} markets waiting for resolution:\n")
            print(f"{'Market ID':<40} {'Title':<40} {'Closes At':<20}")
            print("-" * 100)
            
            for market in markets:
                closes_at = market['closesAt'].strftime('%Y-%m-%d %H:%M') if market['closesAt'] else 'N/A'
                print(f"{market['id']:<40} {market['title']:<40} {closes_at:<20}")
            
        except Exception as e:
            log.error("oracle.manual_override.list_failed", error=str(e))
            raise


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Manual oracle override (testing only, requires DRY_RUN=true)"
    )
    parser.add_argument(
        "--market-id",
        required=False,
        help="Market ID to force resolve"
    )
    parser.add_argument(
        "--outcome",
        choices=['yes', 'no', 'void'],
        required=False,
        help="Outcome to force (yes/no/void)"
    )
    parser.add_argument(
        "--reason",
        default="manual_test",
        help="Reason for override (for audit logging)"
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all unresolved markets"
    )
    parser.add_argument(
        "--db-host",
        default=os.getenv('DB_HOST', 'localhost'),
        help="MySQL host"
    )
    parser.add_argument(
        "--db-user",
        default=os.getenv('DB_USER', 'root'),
        help="MySQL user"
    )
    parser.add_argument(
        "--db-password",
        default=os.getenv('DB_PASSWORD', ''),
        help="MySQL password"
    )
    parser.add_argument(
        "--db-name",
        default=os.getenv('DB_NAME', 'scout'),
        help="MySQL database"
    )
    
    args = parser.parse_args()
    
    oracle = ManualOracle(
        db_host=args.db_host,
        db_user=args.db_user,
        db_password=args.db_password,
        db_name=args.db_name
    )
    
    try:
        if args.list:
            oracle.list_unresolved()
        elif args.market_id and args.outcome:
            oracle.force_resolve(args.market_id, args.outcome, args.reason)
        else:
            parser.print_help()
            sys.exit(1)
    except Exception as e:
        print(f"\n✗ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
