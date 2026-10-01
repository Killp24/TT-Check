"""Collects TT Elite Series data from tt-series.com for the TT-Check app.

Writes:
  ratings.txt  - official Elo ranking
  official.txt - match history built from every player's page
  players.txt  - career wins/losses per player
  schedule.txt - today's and tomorrow's matches
Run by .github/workflows/update-ratings.yml
"""
import html, re, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

BASE = "https://www.tt-series.com/"
UA = {"User-Agent": "Mozilla/5.0 (TT-Check data updater)"}


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print("FAILED", url, e)
                return ""
            time.sleep(5)


def table_rows(page):
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, flags=re.S | re.I):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)) for c in
                 re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)]
        rows.append([re.sub(r"\s+", " ", c).strip() for c in cells])
    return rows


# ---------- 1. ratings ----------
page = get(BASE + "ranking/")
m = re.search(r"as of\s*(\d{4}-\d{2}-\d{2})", page)
as_of = m.group(1) if m else "unknown date"
ranking = [(int(c[0]), c[1], int(c[-1])) for c in table_rows(page)
           if len(c) >= 3 and c[0].isdigit() and c[-1].lstrip("-").isdigit() and c[1]]
if len(ranking) < 100:
    sys.exit(f"Only found {len(ranking)} players in the ranking, so nothing was changed.")
with open("ratings.txt", "w", encoding="utf-8") as f:
    f.write(f"# Official TT Elite Series ranking as of {as_of} (updated automatically)\n")
    for r, n, e in ranking:
        f.write(f"{r}\t{n}\t{e}\n")
print(f"Ratings: {len(ranking)} players as of {as_of}")

# ---------- 2. each player's recent matches ----------
# From each page we get that player's matches in order, so we can number
# them within a day (1 = first match that day).
seen = defaultdict(lambda: defaultdict(list))   # key -> page player -> [(idx, elo)]
career = {}
names = list(dict.fromkeys(n for _, n, _ in ranking))


def fetch_player(name):
    page = get(BASE + "player/?player=" + urllib.parse.quote_plus(name))
    time.sleep(0.3)
    return page


# read 4 pages at a time to keep each run short
with ThreadPoolExecutor(max_workers=4) as pool:
    pages = list(pool.map(fetch_player, names))
print(f"  {sum(1 for p in pages if p)} of {len(names)} player pages read")

for name, page in zip(names, pages):
    w = re.search(r"Wins:\s*(\d+)\s*\|\s*Losses:\s*(\d+)", page)
    if w:
        career[name] = (int(w.group(1)), int(w.group(2)))
    matches = []
    for c in table_rows(page):
        if len(c) < 5 or not re.fullmatch(r"\d+:\d+", c[1]) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", c[3]):
            continue
        p1, p2, date, winner = c[0], c[2], c[3], c[4]
        a, b = map(int, c[1].split(":"))
        if winner not in (p1, p2):
            winner = p1 if a > b else p2
        loser = p2 if winner == p1 else p1
        score = f"{max(a, b)}-{min(a, b)}"
        elo = c[5] if len(c) > 5 else ""
        matches.append((date, winner, loser, score, elo))
    matches.reverse()                     # oldest first
    oldest = matches[0][0] if matches else None
    count = defaultdict(int)
    for date, winner, loser, score, elo in matches:
        count[date] += 1
        # the oldest date on the page may be cut off, so its numbers aren't reliable
        idx = count[date] if (date != oldest or len(matches) < 30) else None
        seen[(date, winner, loser, score)][name].append((idx, elo if name == winner else None))

# Pair up the same match seen on both players' pages (k-th with k-th).
fresh = defaultdict(list)                 # key -> [(iw, il, elo)]
for key, by_page in seen.items():
    date, winner, loser, score = key
    wl, ll = by_page.get(winner, []), by_page.get(loser, [])
    for k in range(max(len(wl), len(ll))):
        iw, elo = wl[k] if k < len(wl) else (None, None)
        il = ll[k][0] if k < len(ll) else None
        fresh[key].append((iw, il, elo))

# ---------- 3. merge with history already saved ----------
old = defaultdict(list)
try:
    for line in open("official.txt", encoding="utf-8"):
        p = [x.strip() for x in line.split("|")]
        if line.startswith("#") or len(p) < 4:
            continue
        num = lambda s: int(s) if s.isdigit() else None
        old[tuple(p[:4])].append((num(p[4]) if len(p) > 4 else None,
                                  num(p[5]) if len(p) > 5 else None,
                                  (p[6] if len(p) > 6 else "") or None))
except FileNotFoundError:
    pass

merged = dict(old)
for key, recs in fresh.items():
    prev = old.get(key, [])
    if len(recs) >= len(prev):
        out = []
        for k, (iw, il, elo) in enumerate(recs):
            piw, pil, pelo = prev[k] if k < len(prev) else (None, None, None)
            out.append((iw or piw, il or pil, elo or pelo))
        merged[key] = out


def order(item):
    (date, winner, loser, score), rec = item
    return (date, rec[0] or rec[1] or 99)


lines = sorted(((k, r) for k, recs in merged.items() for r in recs), key=order)
with open("official.txt", "w", encoding="utf-8") as f:
    f.write("# Official results collected from tt-series.com (updated automatically)\n")
    f.write(f"# updated {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}\n")
    f.write("# date | winner | loser | score | winner's match # that day | loser's match # that day | winner's Elo change\n")
    for (date, winner, loser, score), (iw, il, elo) in lines:
        f.write(f"{date} | {winner} | {loser} | {score} | {iw or ''} | {il or ''} | {elo or ''}\n")
print(f"Matches: {len(lines)} saved ({len(lines) - sum(len(v) for v in old.values())} new)")

with open("players.txt", "w", encoding="utf-8") as f:
    f.write("# Career record from tt-series.com: name | wins | losses\n")
    for name, (w, l) in sorted(career.items()):
        f.write(f"{name} | {w} | {l}\n")


# ---------- 4. today's and tomorrow's schedule ----------
# Each tournament has its own post ("5753. Result 1.10.2026 – night tournament HSC")
# with a table of match times and players; results are filled in as they're played.
import subprocess
from datetime import timedelta
try:
    from zoneinfo import ZoneInfo
    now_pl = datetime.now(ZoneInfo("Europe/Warsaw"))
except Exception:
    now_pl = datetime.now(timezone.utc) + timedelta(hours=2)
wanted = {(now_pl + timedelta(days=k)).date() for k in (-1, 0, 1)}
canon = {re.sub(r"\s+", " ", n).lower(): n for n in names}


def fix_name(raw):
    raw = re.sub(r"\s+", " ", raw.replace(",", " ")).strip()
    return canon.get(raw.lower(), raw.title())


posts = []
for pg in range(1, 7):
    lst = get(BASE + "category/turnieje/" + (f"page/{pg}/" if pg > 1 else ""))
    found = re.findall(r'href="(https://www\.tt-series\.com/(\d+)-result-(\d{1,2})-(\d{1,2})-(\d{4})-([^"/]+)/?)"', lst)
    dates_here = set()
    for url, num, d, m, y, slug in found:
        try:
            day = datetime(int(y), int(m), int(d)).date()
        except ValueError:
            continue
        dates_here.add(day)
        if day in wanted and url not in [p[0] for p in posts]:
            posts.append((url, day, slug.replace("-", " ")))
    if dates_here and max(dates_here) < min(wanted):
        break

sched = []
for url, day, slug in posts:
    page = get(url)
    title = re.search(r"Result [\d.]+\s*[–-]\s*([^<|]+?)\s*(?:<|\|| – International)", html.unescape(page))
    tname = title.group(1).strip() if title else slug
    first = None
    for c in table_rows(page):
        if len(c) >= 4 and re.fullmatch(r"\d{1,2}:\d{2}", c[0]) and "," in c[2] and "," in c[3]:
            t = c[0].zfill(5)
            first = first or t
            date = day + timedelta(days=1) if t < first else day   # night sessions run past midnight
            res = re.sub(r"\s", "", c[4]) if len(c) > 4 else ""
            res = res if re.fullmatch(r"\d:\d", res) else ""
            sched.append((date.isoformat(), t, tname, fix_name(c[2]), fix_name(c[3]), res))
    time.sleep(0.3)

sched.sort()
with open("schedule.txt", "w", encoding="utf-8") as f:
    f.write("# Match schedule from tt-series.com, Polish time (updated automatically)\n")
    f.write("# date | time | tournament | player 1 | player 2 | result\n")
    for row in sched:
        f.write(" | ".join(row) + "\n")
print(f"Schedule: {len(sched)} matches from {len(posts)} tournaments")
subprocess.run(["git", "add", "schedule.txt"], check=False)   # so the workflow saves it too

# Daily snapshot of the official ratings, so their accuracy can be measured later
snap = f"{as_of}\t" + "\t".join(f"{n}={e}" for _, n, e in ranking) + "\n"
try:
    kept = [l for l in open("ratings_history.txt", encoding="utf-8") if not l.startswith(as_of + "\t")]
except FileNotFoundError:
    kept = ["# One line per day: date, then name=Elo for every player\n"]
open("ratings_history.txt", "w", encoding="utf-8").writelines(kept + [snap])
subprocess.run(["git", "add", "ratings_history.txt"], check=False)
print(f"Ratings history: {len(kept)} earlier days on file")
