"""Append-only registry helper for the 2026-10 research package.

Each source row is a tuple:
  (title, authors_org, year, type, provenance, url, access_status, depth, origin_group, note)
ID is assigned sequentially and never reused. Existing rows are never edited.
"""
import csv
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(BASE, "evidence.tsv")
HEADER = [
    "id", "title", "authors_org", "year", "type", "provenance", "url",
    "accessed", "access_status", "depth", "origin_group", "note",
]
ACCESSED = "2026-10-18"


def _next_id():
    if not os.path.exists(PATH):
        return 1
    with open(PATH, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f, delimiter="\t"))
    if len(rows) <= 1:
        return 1
    return int(rows[-1][0].lstrip("S")) + 1


def add(rows):
    new = not os.path.exists(PATH)
    start = _next_id()
    with open(PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f, delimiter="\t", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        if new:
            w.writerow(HEADER)
        for i, r in enumerate(rows):
            if len(r) != 10:
                raise ValueError(f"row {i}: expected 10 fields, got {len(r)}: {r[:2]}")
            sid = f"S{start + i:03d}"
            w.writerow([sid, *r[:6], ACCESSED, *r[6:]])
    return start, start + len(rows) - 1
