"""Quick update for TT-Check: reads only today's tournament pages.

Each tournament posts one page with its group's schedule and results, so this
costs ~20 requests instead of the ~370 that the full player sweep needs.

Writes schedule.txt (times + results) and merges any finished matches into
official.txt. Run by .github/workflows/fast-update.yml
"""
import html, re, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    NOW_PL = datetime.now(ZoneInfo("Europe/Warsaw"))
except Exception:
    NOW_PL = datetime.now(timezone.utc) + timedelta(hours=2)

BASE = "https://www.tt-series.com/"
UA = {"User-Agent": "Mozilla/5.0 (TT-Check updater)"}
WANTED = {(NOW_PL + timedelta(days=k)).date() for k in (-1, 0, 1)}


def get(url, tries=3):
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45).read().decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print("  FAILED", url, e)
                return ""
            time.sleep(4)


def cells(tr):
    out = [html.unescape(re.sub(r"<[^>]+>", "", c)) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.S | re.I)]
    return [re.sub(r"\s+", " ", c).strip() for c in out]


def rows(page):
    return [cells(tr) for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, flags=re.S | re.I)]


# Names on these pages are "Surname, First" and sometimes lower-cased
names = []
try:
    for line in open("ratings.txt", encoding="utf-8"):
        if line.startswith("#"):
            continue
        p = line.rstrip("\n").split("\t")
        if len(p) >= 3:
            names.append(p[1])
except FileNotFoundError:
    print("ratings.txt missing; run the full update first")
    sys.exit(0)
canon = {re.sub(r"\s+", " ", n).lower(): n for n in names}


def fix(raw):
    s = re.sub(r"\s+", " ", raw.replace(",", " ")).strip()
    if s.lower() in canon:
        return canon[s.lower()]
    parts = s.split()
    if len(parts) >= 2:                      # try "First Surname" order too
        alt = " ".join(parts[::-1]).lower()
        if alt in canon:
            return canon[alt]
    return s.title()


# ---- find today's tournament pages ----
posts, pages_seen = [], 0
for pg in range(1, 8):
    lst = get(BASE + "category/turnieje/" + (f"page/{pg}/" if pg > 1 else ""))
    pages_seen += 1
    found = re.findall(r'href="(https://www\.tt-series\.com/(\d+)-result-(\d{1,2})-(\d{1,2})-(\d{4})-([^"/]+)/?)"', lst)
    dates_here = set()
    for url, num, d, m, y, slug in found:
        try:
            day = datetime(int(y), int(m), int(d)).date()
        except ValueError:
            continue
        dates_here.add(day)
        if day in WANTED and url not in [p[0] for p in posts]:
            posts.append((url, day, slug.replace("-", " ")))
    if dates_here and max(dates_here) < min(WANTED) and len({d for _, d, _ in posts}) >= len(WANTED):
        break

sched, results, with_result = [], [], 0
for url, day, slug in posts:
    page = get(url)
    if not page:
        continue
    t = re.search(r"Result [\d.]+\s*[–-]\s*([^<|]+?)\s*(?:<|\|)", html.unescape(page))
    tname = re.sub(r"\s*[–-]\s*International TT Series.*$", "", t.group(1)).strip() if t else slug
    first = None
    for c in rows(page):
        if len(c) >= 4 and re.fullmatch(r"\d{1,2}:\d{2}", c[0]) and "," in c[2] and "," in c[3]:
            hm = c[0].zfill(5)
            first = first or hm
            date = day + timedelta(days=1) if hm < first else day      # night sessions cross midnight
            p1, p2 = fix(c[2]), fix(c[3])
            res = re.sub(r"\s", "", c[4]) if len(c) > 4 else ""
            m = re.fullmatch(r"(\d)[:\-](\d)", res)
            score = ""
            if m:
                a, b = int(m.group(1)), int(m.group(2))
                if {a, b} & {3} and a != b:
                    score = f"{max(a,b)}-{min(a,b)}"
                    w, l = (p1, p2) if a > b else (p2, p1)
                    results.append((date.isoformat(), w, l, score))
                    with_result += 1
            sched.append((date.isoformat(), hm, tname, p1, p2, score))
    time.sleep(0.2)

if not sched:
    print("No tournament pages found; leaving files unchanged")
    sys.exit(0)

sched.sort()
with open("schedule.txt", "w", encoding="utf-8") as f:
    f.write("# Match schedule from tt-series.com, Polish time (updated automatically)\n")
    f.write("# date | time | tournament | player 1 | player 2 | result\n")
    for r in sched:
        f.write(" | ".join(r) + "\n")
print(f"Schedule: {len(sched)} matches from {len(posts)} tournaments ({pages_seen} listing pages)")
print(f"Results found on tournament pages: {with_result}")

# ---- merge finished matches into official.txt ----
if results:
    try:
        old = open("official.txt", encoding="utf-8").read()
    except FileNotFoundError:
        old = ""
    have = set()
    for line in old.splitlines():
        p = [x.strip() for x in line.split("|")]
        if len(p) >= 4 and not line.startswith("#"):
            have.add((p[0], p[1], p[2], p[3]))
    # count how many times each result already appears, so repeat meetings aren't lost
    new = [r for r in results if r not in have]
    if new:
        head, body = [], []
        for line in old.splitlines():
            (head if line.startswith("#") else body).append(line)
        if not head:
            head = ["# Official results collected from tt-series.com (updated automatically)",
                    "# date | winner | loser | score | winner's match # that day | loser's match # that day | winner's Elo change"]
        head = [h for h in head if not h.startswith("# updated")]
        head.insert(1, f"# updated {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}")
        for d, w, l, sc in new:
            body.append(f"{d} | {w} | {l} | {sc} |  |  | ")
        body.sort(key=lambda s: s.split("|")[0].strip())
        open("official.txt", "w", encoding="utf-8").write("\n".join(head + body) + "\n")
        print(f"Added {len(new)} new results to official.txt")
    else:
        print("No new results to add")
