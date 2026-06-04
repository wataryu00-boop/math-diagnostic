#!/usr/bin/env python3
"""
문제 자동 생성: 100문제 미만 개념에 학습 10문제 + 진단후보 1문제(필요시) 생성.
변경 발생 시 _index.json 갱신 + commit + push 까지 자체 수행.
"""
import csv
import io
import json
import os
import subprocess
import sys

try:
    import anthropic
except ImportError:
    print("[GEN-ERROR] anthropic 패키지 필요: pip install anthropic")
    sys.exit(1)

PROBLEMS_DIR = "problems"
INDEX_PATH = "problems/_index.json"
CONCEPTS_PATH = "concepts.csv"
MAX_CONCEPTS = 6

COLS = [
    "문제ID", "점검개념ID", "난이도", "유형", "용도", "문제", "정답", "해설",
    "오답1", "약점1", "오답해설1", "오답2", "약점2", "오답해설2",
    "오답3", "약점3", "오답해설3", "오답4", "약점4", "오답해설4", "그림",
]

SYSTEM_PROMPT = """너는 한국 수학 문제은행 자동 생성 전문가야.
주어진 개념에 대해 정확히 CSV 행만 생성해. 설명, 마크다운, 헤더 절대 금지.

규칙:
- 정확히 21컬럼: 문제ID,점검개념ID,난이도,유형,용도,문제,정답,해설,오답1,약점1,오답해설1,오답2,약점2,오답해설2,오답3,약점3,오답해설3,오답4,약점4,오답해설4,그림
- 용도: 학습 또는 진단검토만 (진단 절대 금지)
- 수식: x² x⁻¹ (x^2 금지), a/b, √2, DE//BC (∥ || ‖ 금지), LaTeX명령 금지
- 약점1~4: concepts.csv의 실제 개념ID여야 함
- 진단후보: 오답4개가 서로 다른 오개념 대표 (단순 계산실수 4개 안 됨)
- 기존 문제와 명확히 다른 표현·수치·맥락 사용
- 그림 컬럼 비워둘 것
- 정답은 답 텍스트 (번호 없음)
- 셀 안에 쉼표 포함 시 큰따옴표로 감싸기
- CSV 행만 출력"""


def load_index():
    with open(INDEX_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_concepts():
    concepts = {}
    with open(CONCEPTS_PATH, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            concepts[row["개념ID"]] = row
    return concepts


def get_max_qid():
    max_id = 0
    for cid in os.listdir(PROBLEMS_DIR):
        cid_dir = f"{PROBLEMS_DIR}/{cid}"
        if not os.path.isdir(cid_dir):
            continue
        for fname in os.listdir(cid_dir):
            if not fname.endswith(".csv"):
                continue
            with open(f"{cid_dir}/{fname}", newline="", encoding="utf-8") as f:
                rows = list(csv.reader(f))
            for row in rows[1:]:
                if row and row[0]:
                    try:
                        max_id = max(max_id, int(row[0]))
                    except ValueError:
                        pass
    return max_id


def get_samples(cid, n=3):
    samples = []
    for level in [1, 2, 3]:
        path = f"{PROBLEMS_DIR}/{cid}/{level}.csv"
        if not os.path.exists(path):
            continue
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        for row in rows[1:]:
            if len(row) >= 6 and row[5]:
                samples.append(row[5])
                if len(samples) >= n:
                    return samples
    return samples


def fmt_qid(n):
    return f"{n:03d}" if n < 1000 else str(n)


def generate(client, cid, concept, samples, start_qid, need_diag):
    sample_text = "\n".join(f"- {s}" for s in samples) if samples else "없음"
    diag_note = (
        "\n마지막에 진단후보 1문제 추가 (난이도=2, 용도=진단검토, 오답4개가 서로 다른 오개념 각각 대표)."
        if need_diag
        else ""
    )
    prompt = (
        f"개념 {cid}: {concept.get('개념명', '')} "
        f"({concept.get('영역', '')}, {concept.get('학년단계', '')})\n"
        f"한줄설명: {concept.get('한줄설명', '')}\n\n"
        f"기존 문제 예시 (아래와 명확히 다른 표현·수치·맥락 사용):\n{sample_text}\n\n"
        f"요청:\n"
        f"- 학습 10문제 (난이도1 3개, 난이도2 4개, 난이도3 3개, 용도=학습){diag_note}\n"
        f"- 시작 문제ID: {fmt_qid(start_qid)}\n"
        f"- 21컬럼 CSV 행만 출력 (헤더 없음)"
    )
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text.strip()


def parse_rows(text):
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) == 21:
            rows.append(row)
        elif any(row):
            print(f"  [SKIP-COLS] {len(row)}컬럼: {row[:3]}")
    return rows


def validate(row):
    if len(row) != 21:
        return False, f"컬럼 수 {len(row)}"
    if row[4] not in ("학습", "진단검토"):
        return False, f"잘못된 용도: {row[4]!r}"
    return True, None


def append_csv(cid, level, rows):
    path = f"{PROBLEMS_DIR}/{cid}/{level}.csv"
    os.makedirs(f"{PROBLEMS_DIR}/{cid}", exist_ok=True)
    exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if not exists:
            w.writerow(COLS)
        w.writerows(rows)


def rebuild_index():
    result = {}
    for cid in sorted(os.listdir(PROBLEMS_DIR)):
        cid_dir = f"{PROBLEMS_DIR}/{cid}"
        if not os.path.isdir(cid_dir):
            continue
        levels, pending = {}, 0
        for fname in sorted(os.listdir(cid_dir)):
            if not fname.endswith(".csv"):
                continue
            level = fname.replace(".csv", "")
            with open(f"{cid_dir}/{fname}", newline="", encoding="utf-8") as f:
                rows = list(csv.reader(f))
            if not rows:
                continue
            levels[level] = len(rows) - 1
            try:
                use_idx = rows[0].index("용도")
                for row in rows[1:]:
                    if len(row) > use_idx and row[use_idx] == "진단검토":
                        pending += 1
            except ValueError:
                pass
        if pending > 0:
            levels["_pending"] = pending
        result[cid] = levels
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, sort_keys=True)
    print("[GEN] _index.json 재계산 완료")
    return result


def commit_push(q_start, q_end, cids, learn_n, diag_n, queue_k=0):
    msg = (
        f"Q{fmt_qid(q_start)} ~ Q{fmt_qid(q_end)}: "
        f"{cids} 학습 {learn_n} + 진단후보 {diag_n} + 결정처리 {queue_k}"
    )
    try:
        subprocess.run(["git", "add", "problems/"], check=True)
        status = subprocess.run(
            ["git", "status", "--porcelain", "--cached"],
            capture_output=True, text=True,
        ).stdout
        for line in status.splitlines():
            fname = line[3:].strip()
            if fname and not fname.startswith("problems/"):
                subprocess.run(["git", "restore", "--staged", fname], check=False)
        subprocess.run(["git", "commit", "-m", msg], check=True)
    except subprocess.CalledProcessError as e:
        print(f"[GEN-WARN] commit 실패: {e}")
        return
    for attempt in range(4):
        r = subprocess.run(["git", "push", "-u", "origin", "main"])
        if r.returncode == 0:
            print(f"[GEN] 커밋+푸시 완료: {msg}")
            return
        wait = 2 ** (attempt + 1)
        print(f"[GEN-WARN] push 실패 (시도 {attempt + 1}), {wait}s 후 rebase 재시도...")
        import time
        time.sleep(wait)
        subprocess.run(["git", "pull", "--rebase", "origin", "main"])
    print("[GEN-ERROR] push 최종 실패 — 다음 실행 때 재시도")


def main():
    index = load_index()
    concepts = load_concepts()

    under = sorted(
        (sum(v for k, v in d.items() if not k.startswith("_")), c)
        for c, d in index.items()
        if sum(v for k, v in d.items() if not k.startswith("_")) < 100
    )

    if not under:
        print("[GEN] 모든 개념 ≥100문제 — 생성 불필요")
        if not os.path.exists(".auto-problems-done"):
            open(".auto-problems-done", "w").close()
            print("[GEN] .auto-problems-done 생성")
        return 0

    targets = under[:MAX_CONCEPTS]
    cid_list = [c for _, c in targets]
    print(f"[GEN] 생성 대상 {len(targets)}개: {cid_list}")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("[GEN-ERROR] ANTHROPIC_API_KEY 환경변수 없음 — 생성 건너뜀")
        return 1

    client = anthropic.Anthropic(api_key=api_key)
    q_start = get_max_qid() + 1
    cur_qid = q_start
    total_learn = 0
    total_diag = 0

    for total, cid in targets:
        concept = concepts.get(cid, {})
        samples = get_samples(cid)
        pending = index.get(cid, {}).get("_pending", 0)
        need_diag = pending < 3

        print(
            f"[GEN] {cid} ({concept.get('개념명', '')}) "
            f"현재{total}문제, pending={pending}, Q{fmt_qid(cur_qid)}~"
        )
        raw = generate(client, cid, concept, samples, cur_qid, need_diag)
        rows = parse_rows(raw)

        by_level = {1: [], 2: [], 3: []}
        for row in rows:
            ok, reason = validate(row)
            if not ok:
                print(f"  [SKIP-VALIDATE] {row[:3]}: {reason}")
                continue
            try:
                lv = int(row[2])
                if lv in by_level:
                    by_level[lv].append(row)
            except (ValueError, IndexError):
                pass

        learn_rows = [r for lv_rows in by_level.values() for r in lv_rows if r[4] == "학습"]
        diag_rows = [r for lv_rows in by_level.values() for r in lv_rows if r[4] == "진단검토"]

        for lv, lv_rows in by_level.items():
            if lv_rows:
                append_csv(cid, lv, lv_rows)

        total_learn += len(learn_rows)
        total_diag += len(diag_rows)
        cur_qid += len(learn_rows) + len(diag_rows)
        print(f"  → 학습 {len(learn_rows)}, 진단후보 {len(diag_rows)} 추가")

    new_index = rebuild_index()
    still_under = [
        c for c, d in new_index.items()
        if sum(v for k, v in d.items() if not k.startswith("_")) < 100
    ]
    if not still_under and not os.path.exists(".auto-problems-done"):
        open(".auto-problems-done", "w").close()

    if cur_qid > q_start:
        commit_push(q_start, cur_qid - 1, ",".join(cid_list), total_learn, total_diag)
    else:
        print("[GEN] 추가된 문제 없음 — 커밋 스킵")

    return 0


if __name__ == "__main__":
    sys.exit(main())
