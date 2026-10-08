"""Save full head-to-head lists from the official tt-series page.

Player profiles only keep the last 30 matches, so older meetings never land in
official.txt. The head-to-head page still has them. This file is for the
match page list. It is not part of the win chance.
"""
import html
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

BASE = "https://www.tt-series.com/h2h/"
UA = {"User-Agent": "Mozilla/5.0 (TT-Check data updater)"}


def _request(data=None, tries=3):
    # A shared opener deadlocks when several pairs are read at once.
    body = data.encode() if isinstance(data, str) else data
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE, data=body, headers=UA)
            with urllib.request.build_opener().open(req, timeout=30) as res:
                return res.read().decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print("FAILED h2h", e, flush=True)
                return ""
            time.sleep(2 + i)


def _cells(tr):
    cells = [html.unescape(re.sub(r"<[^>]+>", "", c)) for c in
             re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)]
    return [re.sub(r"\s+", " ", c).strip() for c in cells]


def page_setup(page):
    nonce = re.search(r'name="two_players_nonce" value="([^"]+)"', page)
    names = re.findall(r'<option value="([^"]+)">', page)
    return (nonce.group(1) if nonce else ""), set(html.unescape(n) for n in names if n)


def parse_h2h_html(page, p1, p2):
    """Rows of (date, winner, loser, score), or None when the page is not that pair."""
    title = re.search(r"<h3>\s*Matches between (.*?) and (.*?):\s*</h3>", page, flags=re.S)
    empty = re.search(r"No matches found between (.*?) and ([^<]+)", page, flags=re.S)
    if title:
        a = html.unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip()
        b = html.unescape(re.sub(r"<[^>]+>", "", title.group(2))).strip()
    elif empty:
        a = html.unescape(re.sub(r"<[^>]+>", "", empty.group(1))).strip()
        b = html.unescape(re.sub(r"<[^>]+>", "", empty.group(2))).strip()
    else:
        return None
    if a != p1 or b != p2:
        return None
    if not title:
        return []
    chunk = page.split("Matches between", 1)[1]
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", chunk, flags=re.S | re.I):
        c = _cells(tr)
        if len(c) < 5 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", c[3]):
            continue
        if not re.fullmatch(r"\d+:\d+", c[1]) or c[4] not in (c[0], c[2]):
            continue
        left, right = (int(x) for x in c[1].split(":"))
        winner, loser = c[4], (c[2] if c[4] == c[0] else c[0])
        rows.append((c[3], winner, loser, f"{max(left, right)}-{min(left, right)}"))
    return rows


def fetch_pair(p1, p2, nonce):
    body = urllib.parse.urlencode({
        "two_players_nonce": nonce,
        "_wp_http_referer": "/h2h/",
        "player1_select": p1,
        "player2_select": p2,
    })
    page = _request(body)
    if not page:
        return None
    return parse_h2h_html(page, p1, p2)


def pair_key(a, b):
    return tuple(sorted((a, b)))


def load_h2h(path):
    """Return (fetched iso by pair, list of match tuples)."""
    fetched = {}
    rows = []
    try:
        lines = open(path, encoding="utf-8")
    except FileNotFoundError:
        return fetched, rows
    for line in lines:
        if line.startswith("# pair |"):
            p = [x.strip() for x in line.split("|")]
            if len(p) >= 4:
                fetched[pair_key(p[1], p[2])] = p[3]
            continue
        if line.startswith("#") or "|" not in line:
            continue
        p = [x.strip() for x in line.split("|")]
        if len(p) >= 4 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p[0]):
            rows.append((p[0], p[1], p[2], p[3]))
    return fetched, rows


def schedule_pairs(path):
    pairs = []
    seen = set()
    try:
        lines = open(path, encoding="utf-8")
    except FileNotFoundError:
        return pairs
    for line in lines:
        if line.startswith("#") or "|" not in line:
            continue
        p = [x.strip() for x in line.split("|")]
        if len(p) < 5 or not p[3] or not p[4] or p[3] == p[4]:
            continue
        key = pair_key(p[3], p[4])
        if key in seen:
            continue
        seen.add(key)
        pairs.append(key)
    return pairs


def write_h2h(path, fetched, rows):
    by_pair = {}
    for date, winner, loser, score in rows:
        by_pair.setdefault(pair_key(winner, loser), []).append((date, winner, loser, score))
    keys = sorted(set(fetched) | set(by_pair))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    out = [
        "# Head-to-head from tt-series.com/h2h/. Display only. The win chance does not use this file.\n",
        f"# updated {now}\n",
    ]
    for key in keys:
        stamp = fetched.get(key, "")
        out.append(f"# pair | {key[0]} | {key[1]} | {stamp}\n")
        for date, winner, loser, score in sorted(by_pair.get(key, [])):
            out.append(f"{date} | {winner} | {loser} | {score}\n")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(out)
    import os
    os.replace(tmp, path)


def refresh_h2h(schedule_path="schedule.txt", h2h_path="h2h.txt", limit=60, max_age_hours=18, workers=4):
    """Refresh up to `limit` scheduled pairs older than `max_age_hours`. Returns how many were fetched."""
    page = _request()
    nonce, names = page_setup(page)
    if not nonce:
        print("Head-to-head: no form token, left the saved file alone.")
        return 0
    fetched, rows = load_h2h(h2h_path)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=max_age_hours)

    def stale(key):
        stamp = fetched.get(key)
        if not stamp:
            return True
        try:
            seen = datetime.strptime(stamp, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
        except ValueError:
            return True
        return seen < cutoff

    wanted = [key for key in schedule_pairs(schedule_path) if stale(key)]
    wanted.sort(key=lambda key: fetched.get(key) or "")
    todo = wanted[:limit]
    if not todo:
        print("Head-to-head: scheduled pairs are already saved.")
        return 0

    def one(key):
        a, b = key
        if a not in names or b not in names:
            return key, []
        got = fetch_pair(a, b, nonce)
        return key, got

    done = 0
    fresh_rows = {}
    replaced = set()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(one, key) for key in todo]
        for fut in as_completed(futs):
            key, got = fut.result()
            if got is None:
                continue
            replaced.add(key)
            fetched[key] = now.strftime("%Y-%m-%dT%H:%MZ")
            fresh_rows[key] = got
            done += 1
            if done % 25 == 0 or done == len(todo):
                write_h2h(h2h_path, fetched, [row for row in rows if pair_key(row[1], row[2]) not in replaced] +
                          [row for got in fresh_rows.values() for row in got])
                print(f"  head-to-head {done} of {len(todo)}", flush=True)
    if not replaced:
        print("Head-to-head: nothing new came back.")
        return 0
    kept = [row for row in rows if pair_key(row[1], row[2]) not in replaced]
    for key, got in fresh_rows.items():
        kept.extend(got)
    write_h2h(h2h_path, fetched, kept)
    print(f"Head-to-head: refreshed {done} pairs, {sum(len(v) for v in fresh_rows.values())} meetings.")
    return done


def main():
    limit, age = 60, 18
    args = sys.argv[1:]
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    if "--max-age" in args:
        age = float(args[args.index("--max-age") + 1])
    refresh_h2h(limit=limit, max_age_hours=age)


if __name__ == "__main__":
    main()
