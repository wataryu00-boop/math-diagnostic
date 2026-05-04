#!/usr/bin/env python3
"""Rebuild problems/_index.json by scanning all problems/*/*.csv files."""
import csv, json, os, re

PROBLEMS_DIR = "/home/user/math-diagnostic/problems"

index = {}

# Collect all concept dirs
for cid in sorted(os.listdir(PROBLEMS_DIR)):
    cid_path = os.path.join(PROBLEMS_DIR, cid)
    if not os.path.isdir(cid_path):
        continue
    index[cid] = {}
    for fname in os.listdir(cid_path):
        if not fname.endswith(".csv"):
            continue
        level = fname.replace(".csv", "")
        fpath = os.path.join(cid_path, fname)
        count = 0
        with open(fpath, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            for i, row in enumerate(reader):
                if i == 0:
                    continue  # skip header
                if len(row) > 0:
                    count += 1
        if count > 0:
            index[cid][level] = count

# Write
index_path = os.path.join(PROBLEMS_DIR, "_index.json")
with open(index_path, "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False, sort_keys=True, indent=2)

# Verify: sum from index vs actual file scan
total_index = sum(sum(v.values()) for v in index.values())
print(f"_index.json 재생성 완료. 총 문제 수: {total_index}")
print("새로 추가된 개념 문제 수:")
for cid in ["C07","C08","C09","C10","D01","D02"]:
    counts = index.get(cid, {})
    total = sum(counts.values())
    print(f"  {cid}: {counts} → 합계 {total}")
