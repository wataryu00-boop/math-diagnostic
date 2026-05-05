#!/usr/bin/env python3
"""교사 결정 큐 처리 - 자동 루틴이 매번 호출.

사용법: python3 scripts/process_decisions.py
출력 마지막 줄: [QUEUE-RESULT] 승격 X / 거절 Y / not_found Z / wrong_state W / error E
"""
import csv
import json
import os
import sys
import urllib.request

SB_URL = "https://yefuyonucatwmonhzyck.supabase.co"
SB_KEY = "sb_publishable_b31qOVHg1vY6Y8ijKFjoPg_X7HHdrNF"
SECRET = "dfe05472eed64f74b7763784ec26135bf51156d8799941eea26814f51b272473"


def call_rpc(name, payload):
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/rpc/{name}",
        data=json.dumps(payload).encode(),
        headers={
            "apikey": SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        body = r.read().decode()
        return json.loads(body) if body else None


def process_one(d):
    cid, qid, decision = d["cid"], d["qid"], d["decision"]
    found = False
    result_text = None
    for level in [2, 1, 3]:
        path = f"problems/{cid}/{level}.csv"
        if not os.path.exists(path):
            continue
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        if not rows:
            continue
        header = rows[0]
        try:
            qid_idx = header.index("문제ID")
            use_idx = header.index("용도")
        except ValueError:
            continue
        new_rows = [header]
        modified = False
        for row in rows[1:]:
            if len(row) > qid_idx and row[qid_idx] == qid:
                found = True
                current_use = row[use_idx] if len(row) > use_idx else ""
                if decision == "promote":
                    if current_use != "진단검토":
                        result_text = f"wrong_state:{current_use}"
                        new_rows.append(row)
                    else:
                        row[use_idx] = "진단"
                        new_rows.append(row)
                        result_text = "promoted"
                        modified = True
                elif decision == "reject":
                    result_text = "rejected"
                    modified = True
            else:
                new_rows.append(row)
        if modified:
            with open(path, "w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerows(new_rows)
            return result_text
        if found:
            return result_text
    return "not_found"


def main():
    try:
        decisions = call_rpc("fetch_pending_decisions", {"secret": SECRET})
    except Exception as e:
        print(f"[QUEUE-ERROR] fetch 실패: {e}")
        decisions = []

    if not isinstance(decisions, list):
        print(f"[QUEUE-ERROR] 응답이 list 가 아님: {decisions}")
        decisions = []

    print(f"[QUEUE] 미처리 결정 {len(decisions)}건")

    stats = {"promoted": 0, "rejected": 0, "not_found": 0, "wrong_state": 0, "error": 0}
    for d in decisions:
        try:
            result_text = process_one(d)
        except Exception as e:
            print(f"[QUEUE-ERROR] {d.get('cid')}/{d.get('qid')}: {e}")
            stats["error"] += 1
            continue
        try:
            call_rpc(
                "mark_decision_processed",
                {"secret": SECRET, "decision_id": d["id"], "result_text": result_text},
            )
        except Exception as e:
            print(f"[QUEUE-WARN] mark 실패 {d['id']}: {e} (CSV 변경은 됐을 수 있음)")
        if result_text == "promoted":
            stats["promoted"] += 1
        elif result_text == "rejected":
            stats["rejected"] += 1
        elif result_text == "not_found":
            stats["not_found"] += 1
        else:
            stats["wrong_state"] += 1
        print(f"  {d['decision']} {d['cid']}/{d['qid']} → {result_text}")

    summary = (
        f"[QUEUE-RESULT] 승격 {stats['promoted']} / 거절 {stats['rejected']} / "
        f"not_found {stats['not_found']} / wrong_state {stats['wrong_state']} / error {stats['error']}"
    )
    print(summary)
    return stats["promoted"] + stats["rejected"]


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)
