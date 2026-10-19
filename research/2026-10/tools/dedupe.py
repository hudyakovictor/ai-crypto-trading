"""Rebuild duplicates.tsv from evidence.tsv.

Rule: two rows are duplicates when the normalized titles are at least 0.90 similar
(difflib) or point to the same URL. The earliest ID becomes canonical.
Run from research/2026-10:  python3 tools/dedupe.py
"""
import csv
import os
import re
import difflib
import collections

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(os.path.join(BASE, "evidence.tsv"), encoding="utf-8"), delimiter="\t"))


def norm(t):
    t = t.lower()
    t = re.sub(r"\(duplicate note\)", "", t)
    t = re.sub(r"[^a-z0-9а-я]+", " ", t)
    return " ".join(t.split())


rows.sort(key=lambda r: r["id"])
parent = {r["id"]: r["id"] for r in rows}


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def union(a, b):
    ra, rb = find(a), find(b)
    if ra == rb:
        return
    if ra < rb:
        parent[rb] = ra
    else:
        parent[ra] = rb


urls = collections.defaultdict(list)
for r in rows:
    urls[r["url"].rstrip("/").lower()].append(r["id"])

dups = []
for ids in urls.values():
    for other in ids[1:]:
        union(ids[0], other)

for i, a in enumerate(rows):
    na = norm(a["title"])
    for b in rows[i + 1:]:
        nb = norm(b["title"])
        if not na or not nb:
            continue
        ratio = difflib.SequenceMatcher(None, na, nb).ratio()
        if ratio >= 0.90:
            union(a["id"], b["id"])
            dups.append((b["id"], a["id"], f"title similarity {ratio:.2f}"))

groups = collections.defaultdict(list)
for r in rows:
    groups[find(r["id"])].append(r["id"])

pairs = []
for root, members in groups.items():
    if len(members) < 2:
        continue
    canonical = min(members)
    for m in sorted(members):
        if m == canonical:
            continue
        reason = f"same title group as {canonical} (fuzzy >= 0.90 or same url)"
        pairs.append((m, canonical, reason))

pairs.sort(key=lambda p: (p[1], p[0]))

with open(os.path.join(BASE, "duplicates.tsv"), "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter="\t", lineterminator="\n")
    w.writerow(["duplicate_id", "canonical_id", "reason"])
    for p in pairs:
        w.writerow(p)

print("rows", len(rows))
print("groups", len([g for g in groups.values() if len(g) > 1]))
print("duplicate rows", len(pairs))
print("unique", len(rows) - len(pairs))
