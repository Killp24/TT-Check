"""Quick update for TT-Check: reads only today's tournament pages.

Each tournament posts one page with its group's schedule and results, so this
costs about 60 requests instead of the ~370 that the full player sweep needs.

Writes schedule.txt (times + results) and merges finished matches into
official.txt. Run every 30 minutes by .github/workflows/fast-update.yml.
"""
import html, re, sys, time, urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    NOW_PL = datetime.now(ZoneInfo("Europe/Warsaw"))
except Exception:
    NOW_PL = datetime.now(timezone.utc) + timedelta(hours=2)

BASE = "https://www.tt-series.com/"
UA = {"User-Agent": "Mozilla/5.0 (TT-Check updater)"}
WANTED = {(NOW_PL + timedelta(days=k)).date() for k in (-1, 0, 1)}
OFFICIAL_MARK = "Official results"
SCHEDULE_MARK = "Match schedule"


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


def parse_sets(cell):
    """Player 1's sets and player 2's sets once a best-of-five is over.

    The site writes 3/1. Older pages wrote 3:1 or 3-1. A row counts when one
    side has reached 3 and the sides are not tied. 1/2 is still in progress.
    """
    res = re.sub(r"\s", "", cell or "")
    m = re.fullmatch(r"(\d)[:\-/](\d)", res)
    if not m:
        return None
    a, b = int(m.group(1)), int(m.group(2))
    if a == b or 3 not in (a, b):
        return None
    return a, b


def fix_name(raw, canon):
    s = re.sub(r"\s+", " ", (raw or "").replace(",", " ")).strip()
    if s.lower() in canon:
        return canon[s.lower()]
    parts = s.split()
    if len(parts) >= 2:
        alt = " ".join(parts[::-1]).lower()
        if alt in canon:
            return canon[alt]
    return s.title()


def load_canon(path="ratings.txt"):
    names = []
    for line in open(path, encoding="utf-8"):
        if line.startswith("#"):
            continue
        p = line.rstrip("\n").split("\t")
        if len(p) >= 3:
            names.append(p[1])
    return {re.sub(r"\s+", " ", n).lower(): n for n in names}


def match_date(day, hm, first, night=False):
    """Calendar date for a row.

    A night page is dated the evening it was posted. Rows at 01:30 are the
    next morning. A page that starts before midnight and later shows 00:30
    rolls forward the same way. Morning pages stay on the posted date.
    """
    hm = (hm or "").zfill(5)
    first = (first or hm).zfill(5)
    if night and hm < "12:00":
        return day + timedelta(days=1)
    if hm < first:
        return day + timedelta(days=1)
    return day


def finished_from_page(page, day, canon, night=False):
    """Return (date, time, p1, p2, sets or None) for each match row."""
    first = None
    found = []
    for c in rows(page):
        if len(c) >= 4 and re.fullmatch(r"\d{1,2}:\d{2}", c[0]) and "," in c[2] and "," in c[3]:
            hm = c[0].zfill(5)
            first = first or hm
            sets = parse_sets(c[4]) if len(c) > 4 else None
            found.append((match_date(day, hm, first, night), hm, fix_name(c[2], canon), fix_name(c[3], canon), sets))
    return found


def split_doc(text):
    head, body = [], []
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        if line.startswith("#") and not body:
            head.append(line)
        elif not line.startswith("#"):
            body.append(line)
    return head, body


def row_key(line):
    p = [x.strip() for x in line.split("|")]
    if len(p) < 4 or not p[0] or not p[1] or not p[2]:
        return None
    return (p[0], p[1], p[2], p[3] if len(p) > 3 else "")


def row_richness(line):
    p = [x.strip() for x in line.split("|")]
    return sum(1 for x in p[4:7] if x)


def stamp_of(text):
    stamps = re.findall(r"^# updated (\S+)", text or "", flags=re.M)
    good = []
    for s in stamps:
        try:
            good.append(datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc))
        except ValueError:
            continue
    return max(good) if good else None


def with_stamp(head, stamp):
    line = f"# updated {stamp}"
    out, seen = [], False
    for h in head:
        if h.startswith("# updated"):
            if not seen:
                out.append(line)
                seen = True
            continue
        out.append(h)
    if not seen:
        out.insert(1 if out else 0, line)
    return out


def blend_bodies(primary, extra, key_fn, better):
    """Keep primary order. Fill gaps from extra. Prefer the richer copy of a row."""
    pools = defaultdict(list)
    for line in extra:
        k = key_fn(line)
        if k:
            pools[k].append(line)
    for k in pools:
        pools[k].sort(key=better, reverse=True)
    seen = Counter()
    out = []
    for line in primary:
        k = key_fn(line)
        if not k:
            continue
        i = seen[k]
        seen[k] = i + 1
        pool = pools.get(k) or []
        if i < len(pool) and better(pool[i]) > better(line):
            out.append(pool[i])
        else:
            out.append(line)
    for k, pool in pools.items():
        for j in range(seen[k], len(pool)):
            out.append(pool[j])
    return out


def blend_official(primary, extra, now=None):
    ph, pb = split_doc(primary)
    _, eb = split_doc(extra)
    body = blend_bodies(pb, eb, row_key, row_richness)
    body.sort(key=lambda s: s.split("|")[0].strip())
    stamps = [t for t in (stamp_of(primary), stamp_of(extra), now) if t]
    stamp = max(stamps).strftime("%Y-%m-%dT%H:%MZ") if stamps else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    if not ph:
        ph = ["# Official results collected from tt-series.com (updated automatically)",
              "# date | winner | loser | score | winner's match # that day | loser's match # that day | winner's Elo change"]
    head = with_stamp(ph, stamp)
    return "\n".join(head + body) + "\n"


def sched_key(line):
    p = [x.strip() for x in line.split("|")]
    if len(p) < 5:
        return None
    return (p[0], p[1], p[3], p[4])


def sched_rich(line):
    p = [x.strip() for x in line.split("|")]
    return 1 if len(p) > 5 and p[5] else 0


def blend_schedule(primary, extra):
    ph, pb = split_doc(primary)
    _, eb = split_doc(extra)
    body = blend_bodies(pb, eb, sched_key, sched_rich)
    body.sort()
    if not ph:
        ph = ["# Match schedule from tt-series.com, Polish time (updated automatically)",
              "# date | time | tournament | player 1 | player 2 | result"]
    return "\n".join(ph + body) + "\n"


def blend_text(primary, extra, now=None):
    sample = ((primary or "") + "\n" + (extra or ""))[:800]
    if OFFICIAL_MARK in sample or "| winner |" in sample:
        return blend_official(primary, extra, now=now)
    return blend_schedule(primary, extra)


def result_row(date, p1, p2, sets):
    a, b = sets
    score = f"{max(a, b)}-{min(a, b)}"
    winner, loser = (p1, p2) if a > b else (p2, p1)
    return f"{date.isoformat()} | {winner} | {loser} | {score} |  |  | "


def main():
    dry = "--dry-run" in sys.argv
    try:
        canon = load_canon()
    except FileNotFoundError:
        print("ratings.txt missing; run the full update first")
        return 0

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

    sched, results = [], []
    for url, day, slug in posts:
        page = get(url)
        if not page:
            continue
        t = re.search(r"Result [\d.]+\s*[–-]\s*([^<|]+?)\s*(?:<|\|)", html.unescape(page))
        tname = re.sub(r"\s*[–-]\s*International TT Series.*$", "", t.group(1)).strip() if t else slug
        night = "night" in slug.lower() or "night" in tname.lower()
        for date, hm, p1, p2, sets in finished_from_page(page, day, canon, night):
            shown = f"{sets[0]}:{sets[1]}" if sets else ""
            sched.append((date.isoformat(), hm, tname, p1, p2, shown))
            if sets:
                results.append(result_row(date, p1, p2, sets))
        time.sleep(0.2)

    if not sched:
        print("No tournament pages found; leaving files unchanged")
        return 0

    sched.sort()
    schedule_text = "# Match schedule from tt-series.com, Polish time (updated automatically)\n"
    schedule_text += "# date | time | tournament | player 1 | player 2 | result\n"
    schedule_text += "".join(" | ".join(r) + "\n" for r in sched)
    print(f"Schedule: {len(sched)} matches from {len(posts)} tournaments ({pages_seen} listing pages)")
    print(f"Finished scores on tournament pages: {len(results)}")

    try:
        old = open("official.txt", encoding="utf-8").read()
    except FileNotFoundError:
        old = ""
    if results:
        incoming = "# Official results collected from tt-series.com (updated automatically)\n" + "".join(line + "\n" for line in results)
        blended = blend_official(old, incoming, now=datetime.now(timezone.utc))
        before, after = Counter(), Counter()
        for line in split_doc(old)[1]:
            k = row_key(line)
            if k:
                before[k] += 1
        for line in split_doc(blended)[1]:
            k = row_key(line)
            if k:
                after[k] += 1
        extra = []
        for k, n in after.items():
            extra.extend([k] * (n - before[k]))
        extra.sort()
        by_date = Counter(k[0] for k in extra)
        print(f"Official results added: {len(extra)}")
        if by_date:
            print("Added by date:", ", ".join(f"{d} {n}" for d, n in sorted(by_date.items())))
        for k in extra[:8]:
            print("  new:", " | ".join(k))
        print(f"Results list stamp: {stamp_of(blended).strftime('%Y-%m-%dT%H:%MZ')}")
    else:
        blended = old
        print("No finished scores on tournament pages; official list left unchanged")

    if dry:
        print("Dry run; files not written")
        return 0
    open("schedule.txt", "w", encoding="utf-8").write(schedule_text)
    if results:
        open("official.txt", "w", encoding="utf-8").write(blended)
    return 0


if __name__ == "__main__":
    sys.exit(main())
