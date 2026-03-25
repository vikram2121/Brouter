# oracle/adapters/base.py
# Shared types for all oracle adapters.

from dataclasses import dataclass
from enum import Enum


class Outcome(str, Enum):
    YES     = "yes"
    NO      = "no"
    VOID    = "void"     # Market cancelled — return all stakes
    PENDING = "pending"  # Not resolved yet


@dataclass
class ResolutionEvent:
    outcome:     Outcome
    resolved_at: int    # Unix timestamp
    source_url:  str    # Exact URL queried — stored for audit
    source_data: dict   # Raw API response — stored for audit
    confidence:  float  # 1.0 = certain, 0.0 = pending
