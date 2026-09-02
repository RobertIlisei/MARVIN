#!/usr/bin/env python3
"""Where did a MARVIN session's wall-clock actually go? (ADR-0067)

Splits a session transcript into MARVIN-working time vs waiting-on-the-user
time, then classifies the waiting by CAUSE — which is the part that matters.

The measurement that produced ADR-0067, on a real 2-day session:

    TOTAL SPAN     49.0h
    MARVIN working 15.9h  (32.4%)
    WAITING ON YOU 33.1h  (67.5%)

      17.8h (53.8%) n=65  STOPPED with no question (should have continued)
       6.7h (20.3%) n=20  asked permission for in-scope work
       5.1h (15.5%) n= 4  CRASH / no closing text
       3.4h (10.3%) n=13  waiting on background job (by design)

Only the last row is legitimate — plus, since 2026-09-02, "BLOCKED on a named
human action", for a turn whose closing message names something only the user
can do (push a tag, approve a prod step). Re-run this after a long plan to check whether
the ADR-0067 gating change actually moved those numbers — the success signal is
the first two rows shrinking, NOT the total span.

Usage:
    python3 scripts/session-time-breakdown.py <session.jsonl>
    python3 scripts/session-time-breakdown.py --latest <projectId>

Transcripts live at $MARVIN_DATA_DIR/sessions/<projectId>/<sessionId>.jsonl
(default ~/.marvin/).
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def data_dir() -> Path:
    return Path(os.environ.get("MARVIN_DATA_DIR", Path.home() / ".marvin"))


def latest_for(project_id: str) -> Path:
    d = data_dir() / "sessions" / project_id
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        sys.exit(f"no transcripts in {d}")
    return files[0]


def classify(end_text: str) -> str:
    """Why did MARVIN stop? Ordered most-specific first."""
    e = end_text.lower()
    if not end_text.strip() or "api error" in e or "stream idle timeout" in e:
        return "CRASH / no closing text"
    if re.search(r"wakeup|background job|pick back up automatically|polling|watching (for|the|it)", e):
        return "waiting on background job (by design)"
    # The last message names something only the user can do — push a tag,
    # merge, approve a prod ceremony, review a design. Session 8927baf0
    # (2026-09-02) had 20 "stopped with no question" waits and, read one by
    # one, most were this. Counting them as stalls overstated ADR-0067's
    # problem by ~3x on that session.
    if re.search(
        r"waiting on you|waiting for you|let me know when|once (that|it)'?s (pushed|merged|approved|done)"
        r"|needs? your (go-ahead|review|approval|read|sign-off|audit)|your call"
        r"|before i touch|i('| wi)ll wait for your|when you('|')?ve|after you (push|merge|approve|review)"
        r"|blocked on you|i'll check with you before|wait for your go-ahead",
        e,
    ):
        return "BLOCKED on a named human action (legitimate)"
    if end_text.rstrip().endswith("?") or re.search(
        r"want me to|approve to|should i |or handle a subset|shall i ", e
    ):
        return "asked permission for in-scope work"
    return "STOPPED with no question (should have continued)"


def main() -> None:
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    path = latest_for(args[1]) if args[0] == "--latest" and len(args) > 1 else Path(args[0])
    if not path.exists():
        sys.exit(f"not found: {path}")

    rows: list[tuple[str, datetime, str]] = []
    work = 0.0
    open_start: datetime | None = None
    last_text = ""
    errors = 0
    rate_limits = 0

    with path.open() as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = r.get("type")
            at = r.get("at")
            if kind == "cli.event":
                ev = r.get("event") or {}
                if ev.get("type") == "assistant":
                    for b in (ev.get("message") or {}).get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                            last_text = b["text"].strip()
                elif ev.get("type") == "rate_limit_event":
                    rate_limits += 1
            elif kind == "turn.started" and at:
                open_start = ts(at)
            elif kind in ("turn.completed", "turn.error") and at:
                if kind == "turn.error":
                    errors += 1
                if open_start:
                    work += (ts(at) - open_start).total_seconds()
                    open_start = None
                rows.append(("end", ts(at), last_text))
                last_text = ""
            elif kind == "turn.user" and at:
                rows.append(("user", ts(at), r.get("message") or ""))

    if not rows:
        sys.exit("no turns found — is this a MARVIN transcript?")

    gaps: list[tuple[float, str, str]] = []
    prev: tuple[datetime, str] | None = None
    for kind, t, txt in rows:
        if kind == "end":
            prev = (t, txt)
        elif kind == "user" and prev:
            g = (t - prev[0]).total_seconds()
            if g > 0:
                gaps.append((g, prev[1], txt))
            prev = None

    span = (rows[-1][1] - rows[0][1]).total_seconds()
    idle = sum(g for g, _, _ in gaps)
    h = lambda s: f"{s / 3600:.1f}h"  # noqa: E731

    print(f"session: {path.name}")
    print(f"TOTAL SPAN     {h(span)}  ({span / 86400:.1f} days)")
    print(f"MARVIN working {h(work)}   ({work / span * 100:.1f}%)" if span else "")
    print(f"WAITING ON YOU {h(idle)}   ({idle / span * 100:.1f}%)" if span else "")
    print(f"turns: {sum(1 for k, _, _ in rows if k == 'end')}   "
          f"turn errors: {errors}   rate-limit events: {rate_limits}")

    agg: dict[str, list[float]] = {}
    for g, end_text, _ in gaps:
        a = agg.setdefault(classify(end_text), [0.0, 0])
        a[0] += g
        a[1] += 1
    print(f"\n{h(idle)} of waiting, by cause:")
    for b, (s, c) in sorted(agg.items(), key=lambda x: -x[1][0]):
        pct = f"{s / idle * 100:4.1f}%" if idle else "  n/a"
        print(f"  {s / 3600:6.1f}h ({pct}) n={int(c):3}  {b}")

    print("\nlongest waits:")
    for g, end_text, usr in sorted(gaps, reverse=True)[:5]:
        print(f"  {g / 3600:5.1f}h  MARVIN ended: {end_text[-90:]!r}")
        print(f"          you replied: {usr[:80]!r}")

    macro = sum(1 for _, _, u in gaps if "ONLY this plan" in u)
    if macro:
        print(f"\n⚠ resume-macro used {macro}× — ADR-0067 says this should be 0.")


if __name__ == "__main__":
    main()
