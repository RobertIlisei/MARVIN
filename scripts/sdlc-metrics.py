#!/usr/bin/env python3
"""SDLC leading/lagging indicators for MARVIN's own repo.

Prompted by Anthropic's AI-native SDLC playbook
(https://claude.com/blog/the-ai-native-sdlc-playbook), which names two
indicator classes:

  LEADING  — time from idea to committed artifact, first-pass CI success,
             review cycle time.
  LAGGING  — defect escape rate, repeat incidents, rework per change,
             DORA metrics.

MARVIN's ship flow is "commit -> FF push to main" (see feedback memory
`feedback_ship_flow`), not PR review, so "review cycle time" has no signal
here and is deliberately not computed. What IS computed, all read-only from
git/gh/ADRs, no new persistent state:

  - Deployment frequency   (DORA)     — release tags per week
  - Lead time for changes  (DORA)     — commit authored -> release tag, per commit
  - Change failure rate    (DORA)     — % of ADRs later touched by an
                                         addendum/correction commit (this
                                         repo's own rework signal — see
                                         ADR-0068's "addendum" pattern)
  - MTTR                   (DORA)     — ADR creation -> its first addendum/
                                         correction commit
  - CI success rate        (leading)  — % of `push` runs of test.yml that
                                         succeeded

Usage:
    python3 scripts/sdlc-metrics.py [--since YYYY-MM-DD] [--repo PATH]

Requires `git` and (for CI success rate only) `gh` authenticated against
the repo's remote. Missing `gh` degrades gracefully — every other section
still prints.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAG_RE = re.compile(r"^v0\.\d+\.\d+$")  # v1.2.0 / v1.3.0 are stray, no release


def run(args: list[str], cwd: Path) -> str:
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        return ""
    return r.stdout.strip()


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def tags_with_dates(repo: Path) -> list[tuple[str, datetime]]:
    out = run(["git", "log", "--tags", "--simplify-by-decoration", "--date=iso-strict",
               "--pretty=%ad %D"], repo)
    tags: list[tuple[str, datetime]] = []
    for line in out.splitlines():
        date_part, _, refs = line.partition(" ")
        for ref in refs.split(", "):
            m = re.search(r"tag: (v\S+)", ref)
            if m and TAG_RE.match(m.group(1)):
                tags.append((m.group(1), parse_iso(date_part)))
    return sorted(tags, key=lambda t: t[1])


def deployment_frequency(tags: list[tuple[str, datetime]], since: datetime) -> tuple[int, float]:
    in_window = [t for t in tags if t[1] >= since]
    days = max((datetime.now(timezone.utc) - since).days, 1)
    return len(in_window), len(in_window) / days * 7


def lead_time_for_changes(repo: Path, tags: list[tuple[str, datetime]]) -> list[float]:
    """Hours from each commit's author date to the release tag that shipped it."""
    deltas: list[float] = []
    prev_tag = None
    for tag, tag_date in tags:
        range_spec = f"{prev_tag}..{tag}" if prev_tag else tag
        out = run(["git", "log", range_spec, "--format=%aI"], repo)
        for line in out.splitlines():
            if not line:
                continue
            deltas.append((tag_date - parse_iso(line)).total_seconds() / 3600)
        prev_tag = tag
    return [d for d in deltas if d >= 0]


def adr_files(repo: Path) -> list[Path]:
    d = repo / "docs" / "decisions"
    return sorted(p for p in d.glob("*.md") if p.name != "README.md")


REWORK_RE = re.compile(r"addendum|correction", re.IGNORECASE)


def adr_history(repo: Path, path: Path) -> list[tuple[datetime, str]]:
    """(date, subject) for every commit touching this ADR, oldest first."""
    rel = path.relative_to(repo)
    out = run(["git", "log", "--follow", "--format=%aI\t%s", "--", str(rel)], repo)
    hist = []
    for line in out.splitlines():
        date_s, _, subject = line.partition("\t")
        if date_s:
            hist.append((parse_iso(date_s), subject))
    return list(reversed(hist))


def change_failure_rate_and_mttr(repo: Path) -> tuple[int, int, list[float]]:
    files = adr_files(repo)
    reworked = 0
    mttr_days: list[float] = []
    for f in files:
        hist = adr_history(repo, f)
        if not hist:
            continue
        created = hist[0][0]
        rework = next((d for d, s in hist[1:] if REWORK_RE.search(s)), None)
        if rework:
            reworked += 1
            mttr_days.append((rework - created).total_seconds() / 86400)
    return reworked, len(files), mttr_days


def ci_success_rate(repo: Path, since: datetime, workflow: str = "test.yml") -> tuple[int, int] | None:
    if not run(["gh", "--version"], repo):
        return None
    out = run(["gh", "run", "list", f"--workflow={workflow}", "--limit", "200",
               "--json", "conclusion,event,createdAt"], repo)
    if not out:
        return None
    runs = json.loads(out)
    pushes = [r for r in runs if r["event"] == "push" and parse_iso(r["createdAt"]) >= since]
    ok = sum(1 for r in pushes if r["conclusion"] == "success")
    return ok, len(pushes)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default=None, help="YYYY-MM-DD, default 90 days ago")
    ap.add_argument("--repo", default=".", help="repo root, default cwd")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    since = (
        datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
        if args.since
        else datetime.now(timezone.utc) - timedelta(days=90)
    )

    print(f"SDLC metrics for {repo.name} — since {since:%Y-%m-%d}")
    print("(review cycle time not computed — this repo ships via FF push, not PR review)\n")

    tags = tags_with_dates(repo)
    if not tags:
        print("no release tags found (expected vX.Y.Z) — deployment/lead-time metrics skipped")
    else:
        n, per_week = deployment_frequency(tags, since)
        print(f"DEPLOYMENT FREQUENCY   {n} releases in window  (~{per_week:.1f}/week)")

        deltas = lead_time_for_changes(repo, tags)
        if deltas:
            print(f"LEAD TIME FOR CHANGES  median {statistics.median(deltas):.1f}h  "
                  f"(commit -> release tag, n={len(deltas)})")

    reworked, total_adrs, mttr_days = change_failure_rate_and_mttr(repo)
    if total_adrs:
        pct = reworked / total_adrs * 100
        print(f"CHANGE FAILURE RATE    {reworked}/{total_adrs} ADRs ({pct:.1f}%) "
              f"needed an addendum/correction after acceptance")
    if mttr_days:
        print(f"MTTR                   median {statistics.median(mttr_days):.1f} days  "
              f"(ADR accepted -> first addendum/correction, n={len(mttr_days)})")

    ci = ci_success_rate(repo, since)
    if ci is None:
        print("CI SUCCESS RATE        n/a (gh CLI unavailable or no workflow runs)")
    else:
        ok, total = ci
        print(f"CI SUCCESS RATE        {ok}/{total} push runs "
              f"({ok / total * 100:.1f}%)" if total else "CI SUCCESS RATE        no push runs in window")

    print("\nThese are proxies, not the DORA-canonical definitions (no staging/prod split,\n"
          "no incident tracker) — read trend direction, not the absolute numbers.")


if __name__ == "__main__":
    main()
