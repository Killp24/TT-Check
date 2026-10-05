// Pure bet and snapshot helpers. Loaded by index.html and by settle.test.js.
function parlayTicketStatus(legs) {
  if (!legs || !legs.length) return "pending";
  if (legs.some(l => l.status === "lost")) return "lost";
  const live = legs.filter(l => l.status !== "void");
  if (!live.length) return "void";
  if (live.every(l => l.status === "won")) return "won";
  return "pending";
}

function decOf(o) { return o < 0 ? 1 + 100 / (-o) : 1 + o / 100; }
function amOf(d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }

// After a void leg, pay the parlay as if that leg was never on the ticket.
// A lost ticket does not rewrite the other legs; this only changes the price.
function parlayPayoutOdds(bet) {
  if (!bet || !bet.parlay || !bet.legs) return bet ? bet.odds : 0;
  const live = bet.legs.filter(l => l.status !== "void");
  if (!live.length || live.length === bet.legs.length) return bet.odds;
  if (live.length === 1) return live[0].odds;
  return amOf(live.reduce((s, l) => s * decOf(l.odds), 1));
}

function profitOf(o) { return o < 0 ? 100 * 100 / (-o) : o; }

// True when the two prices are the same pair, in either order.
function pricePairMatch(o1, o2, a, b) {
  const nums = [o1, o2, a, b].map(Number);
  if (nums.some(n => !Number.isFinite(n))) return false;
  const x = [nums[0], nums[1]].sort((p, q) => p - q);
  const y = [nums[2], nums[3]].sort((p, q) => p - q);
  return x[0] === y[0] && x[1] === y[1];
}

// Both American prices have to be real numbers of at least 100. One side is not a line.
function bothPrices(o1, o2) {
  const nums = [Number(o1), Number(o2)];
  return nums.every(n => Number.isFinite(n) && Math.abs(n) >= 100);
}

// The plus-money number in a two-sided price. +102 / −136 returns 102.
function pairPlusOdds(a, b) {
  const nums = [Number(a), Number(b)];
  if (nums.some(n => !Number.isFinite(n))) return null;
  const pos = nums.filter(n => n > 0);
  return pos.length === 1 ? pos[0] : null;
}

// A single bet on the plus side of this exact pair.
// Older tickets sometimes stored only the plus number. Those count.
// A second price that is not this pair stays out.
function betOnFlaggedPlus(bet, a, b) {
  if (!bet || bet.parlay) return false;
  const plus = pairPlusOdds(a, b);
  if (plus == null || Number(bet.odds) !== plus) return false;
  const s = bet.snap;
  if (s && s.o1 != null && s.o2 != null) return pricePairMatch(s.o1, s.o2, a, b);
  if (Array.isArray(bet.flagPair) && bet.flagPair[0] != null && bet.flagPair[1] != null)
    return pricePairMatch(bet.flagPair[0], bet.flagPair[1], a, b);
  return true;
}

// ROI is profit divided by stakes on bets that have won or lost. Pending stays out.
function roiOf(rows) {
  const list = rows || [];
  const settled = list.filter(b => b && (b.status === "won" || b.status === "lost"));
  let staked = 0, profit = 0, won = 0;
  for (const b of settled) {
    const stake = +b.stake || 0;
    staked += stake;
    if (b.status === "won") {
      won++;
      profit += stake * profitOf(+b.odds) / 100;
    } else profit -= stake;
  }
  return {
    n: list.length,
    settled: settled.length,
    pending: list.filter(b => b && b.status === "pending").length,
    won,
    lost: settled.length - won,
    staked,
    profit,
    roi: staked ? profit / staked : null
  };
}

// Book price, app win probability, EV per $100, and the time that read was taken.
// o1/app1/edge1 belong to the first player in the caller's order.
function decisionSnapshot(o1, o2, app1, app2, at) {
  const edge = (o, p) => (o === null || o === undefined || p === null || p === undefined || Number.isNaN(p))
    ? null
    : Math.round((p * profitOf(o) - (1 - p) * 100) * 100) / 100;
  const roundP = p => (p === null || p === undefined || Number.isNaN(p)) ? null : Math.round(p * 1000) / 1000;
  return {
    at: at || Date.now(),
    o1: o1 ?? null,
    o2: o2 ?? null,
    app1: roundP(app1),
    app2: roundP(app2),
    edge1: edge(o1 ?? null, app1),
    edge2: edge(o2 ?? null, app2)
  };
}

// Logit gap between what happened and what was expected, shrunk toward zero.
function shrunkShift(n, won, exp, prior) {
  if (!n) return 0;
  const cl = p => Math.min(0.97, Math.max(0.03, p));
  const lgt = p => Math.log(p / (1 - p));
  return (lgt(cl(won / n)) - lgt(cl(exp / n))) * n / (n + prior);
}

// Settle each leg from its own result. A lost leg marks the ticket lost and
// leaves every other leg exactly as it was.
function settleParlayLegs(bet, findResult) {
  if (!bet || !bet.parlay || !bet.legs) return false;
  let changed = false;
  for (const leg of bet.legs) {
    if (leg.status !== "pending" || leg.manual) continue;
    const m = findResult(leg);
    if (!m) continue;
    leg.status = m.w === leg.pick ? "won" : "lost";
    leg.score = m.score || "";
    leg.matchRaw = m.raw;
    changed = true;
  }
  const next = parlayTicketStatus(bet.legs);
  if (bet.status !== next) {
    bet.status = next;
    changed = true;
  }
  return changed;
}

function clampProb(p) {
  return Math.min(0.995, Math.max(0.005, p));
}

function logit(p) {
  const c = clampProb(p);
  return Math.log(c / (1 - c));
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function logLoss(p, y) {
  const c = clampProb(p);
  return y ? -Math.log(c) : -Math.log(1 - c);
}

function logitBlend(app, book, w) {
  return sigmoid((1 - w) * logit(app) + w * logit(book));
}

// Favorite win rate by rating gap. Bins that fall as the gap grows are pooled
// so a bigger favorite is never given a lower chance than a smaller one.
function fitWinCurve(rows, minBin) {
  minBin = minBin || 40;
  const bins = [];
  for (let i = 0; i < 10; i++) bins.push({ x: 0.525 + i * 0.05, n: 0, w: 0 });
  for (const row of rows || []) {
    const p = row[0], y = row[1];
    if (p == null || Number.isNaN(p) || y == null) continue;
    const fav = Math.max(p, 1 - p);
    const won = p >= 0.5 ? y : 1 - y;
    const i = Math.min(9, Math.max(0, Math.floor((fav - 0.5) / 0.05)));
    bins[i].n++;
    bins[i].w += won;
  }
  const pts = bins.filter(b => b.n >= minBin).map(b => ({ x: b.x, y: b.w / b.n, w: b.n }));
  if (pts.length < 3) return null;
  const blocks = pts.map(p => ({ x0: p.x, x1: p.x, y: p.y, w: p.w }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].y <= blocks[i + 1].y + 1e-9) { i++; continue; }
    const a = blocks[i], b = blocks[i + 1];
    const w = a.w + b.w;
    blocks.splice(i, 2, { x0: a.x0, x1: b.x1, y: (a.y * a.w + b.y * b.w) / w, w });
    if (i) i--;
  }
  return blocks;
}

function applyWinCurve(p, blocks) {
  if (!blocks || !blocks.length || p == null || Number.isNaN(p)) return null;
  const fav = Math.max(p, 1 - p);
  const centers = blocks.map(b => ({ x: (b.x0 + b.x1) / 2, y: b.y }));
  let rate;
  if (fav <= centers[0].x) rate = centers[0].y;
  else if (fav >= centers[centers.length - 1].x) rate = centers[centers.length - 1].y;
  else {
    let j = 1;
    while (j < centers.length && centers[j].x < fav) j++;
    const a = centers[j - 1], b = centers[j];
    const t = (fav - a.x) / ((b.x - a.x) || 1);
    rate = a.y + t * (b.y - a.y);
  }
  rate = Math.min(0.98, Math.max(0.5, rate));
  return p >= 0.5 ? rate : 1 - rate;
}

function marginFactor(score) {
  const s = String(score || "");
  if (s === "3-0" || s === "0-3") return 1;
  if (s === "3-1" || s === "1-3") return 0.8;
  if (s === "3-2" || s === "2-3") return 0.55;
  return 1;
}

// rows are oldest first: {e, won, score}. mode is plain, margin, decay, or both.
function recentShift(rows, mode, prior) {
  if (!rows || rows.length < 8) return null;
  const decay = mode === "decay" || mode === "both" ? 0.82 : 1;
  const margin = mode === "margin" || mode === "both";
  let sw = 0, sy = 0, se = 0;
  const n = rows.length;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(decay, n - 1 - i) * (margin ? marginFactor(rows[i].score) : 1);
    sw += w;
    sy += w * (rows[i].won ? 1 : 0);
    se += w * rows[i].e;
  }
  if (sw <= 0) return null;
  return { n, w: sy, exp: se, shift: shrunkShift(sw, sy, se, prior == null ? 80 : prior) };
}

function h2hShiftFrom(rows, wantFirst, prior) {
  if (!rows || rows.length < 5) return null;
  let aw = 0, exp = 0;
  for (const x of rows) {
    if (wantFirst ? x.firstWon : !x.firstWon) aw++;
    exp += wantFirst ? x.eFirst : 1 - x.eFirst;
  }
  return { n: rows.length, aw, exp, diff: aw - exp, shift: shrunkShift(rows.length, aw, exp, prior == null ? 40 : prior) };
}

function sessionBin(n) {
  n = n | 0;
  if (n <= 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  return 3;
}

function fitSessionShifts(rows, minN, prior) {
  minN = minN || 80;
  prior = prior == null ? 150 : prior;
  const bins = {};
  for (const r of rows || []) {
    const sides = [[r.bw, r.e, 1], [r.bl, 1 - r.e, 0]];
    for (const [bin, e, y] of sides) {
      if (!bin) continue;
      const a = bins[bin] || (bins[bin] = { n: 0, w: 0, exp: 0 });
      a.n++;
      a.w += y;
      a.exp += e;
    }
  }
  const shift = {};
  for (const k of Object.keys(bins)) {
    const a = bins[k];
    if (a.n < minN) continue;
    const s = shrunkShift(a.n, a.w, a.exp, prior);
    if (Math.abs(s) >= 0.02) shift[k] = s;
  }
  return shift;
}

// Keep a nudge only when it lowers the error by minGain per match.
function chooseNudge(baseLoss, options, n, minGain) {
  minGain = minGain == null ? 0.001 : minGain;
  if (!n || n < 150) return "off";
  let best = null;
  for (const id of Object.keys(options || {})) {
    const loss = options[id];
    if (best == null || loss < best.loss) best = { id, loss };
  }
  if (!best || (baseLoss - best.loss) / n < minGain) return "off";
  return best.id;
}

// Walk-forward: the weight for each priced match is fit only on earlier ones.
// The live weight is kept when that mix beat the app on the matches it was scored on.
function bestBlendWeight(rows) {
  const empty = { w: 0, n: rows ? rows.length : 0, scored: 0, appLoss: 0, bookLoss: 0, blendLoss: 0, ready: false };
  if (!rows || rows.length < 25) return empty;
  function lossAt(w, subset) {
    let s = 0;
    for (const r of subset) s += logLoss(logitBlend(r.app, r.book, w), r.y);
    return s;
  }
  function bestW(subset) {
    let best = { w: 0, s: lossAt(0, subset) };
    for (let i = 1; i <= 20; i++) {
      const w = i / 20;
      const s = lossAt(w, subset);
      if (s < best.s - 1e-9) best = { w, s };
    }
    return best;
  }
  let wf = 0, app = 0, book = 0, scored = 0;
  for (let i = 25; i < rows.length; i++) {
    const w = bestW(rows.slice(0, i)).w;
    const r = rows[i];
    wf += logLoss(logitBlend(r.app, r.book, w), r.y);
    app += logLoss(r.app, r.y);
    book += logLoss(r.book, r.y);
    scored++;
  }
  const fitted = bestW(rows);
  const ready = scored >= 15 && wf < app - 1e-6;
  return { w: ready ? fitted.w : 0, n: rows.length, scored, appLoss: app, bookLoss: book, blendLoss: wf, ready };
}

// Winner-first match score, such as "3-1". Anything else is left out of the set stats.
function setsFromScore(score) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(score || "").trim());
  if (!m) return null;
  const won = +m[1], lost = +m[2];
  if (won < lost || won < 1) return null;
  return { won, lost };
}

// Newest matches first. Each row is { won, score }.
// Clean wins are 3–0 and 3–1. A decider is a match the loser took to the last game.
function recentShape(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let setsFor = 0, setsAgainst = 0, clean = 0, decW = 0, decN = 0, scored = 0;
  for (const row of list) {
    const s = setsFromScore(row && row.score);
    if (!s) continue;
    scored++;
    const mine = row.won ? s.won : s.lost;
    const theirs = row.won ? s.lost : s.won;
    setsFor += mine;
    setsAgainst += theirs;
    if (s.lost === s.won - 1) {
      decN++;
      if (row.won) decW++;
    } else if (row.won) clean++;
  }
  const w = list.reduce((n, row) => n + (row && row.won ? 1 : 0), 0);
  const last = list.slice(0, 5);
  const hotW = last.reduce((n, row) => n + (row && row.won ? 1 : 0), 0);
  return { n: list.length, w, scored, setsFor, setsAgainst, setDiff: setsFor - setsAgainst, clean, decW, decN, hotN: last.length, hotW };
}

// Higher value wins. A thin sample on either side stays uncolored.
function formEdgeSide(av, bv, aN, bN, minN) {
  if (!(aN >= minN) || !(bN >= minN)) return "";
  if (av === bv) return "";
  return av > bv ? "A" : "B";
}

function fmtRec(w, n) { return n ? w + "–" + (n - w) : "none"; }
function fmtMargin(d) { return d > 0 ? "+" + d : d < 0 ? "−" + (-d) : "0"; }
const rate = (w, n) => n ? w / n : 0;

// Five reads of the same window. side is "A", "B", or "" when they tie or the sample is thin.
function recentStatRows(a, b) {
  a = a || recentShape([]);
  b = b || recentShape([]);
  const per = s => s.scored ? s.setDiff / s.scored : 0;
  return [
    { key: "wins", label: "Wins", side: formEdgeSide(rate(a.w, a.n), rate(b.w, b.n), a.n, b.n, 5), A: fmtRec(a.w, a.n), B: fmtRec(b.w, b.n) },
    { key: "margin", label: "Set margin", side: formEdgeSide(per(a), per(b), a.scored, b.scored, 5), A: a.scored ? fmtMargin(a.setDiff) : "none", B: b.scored ? fmtMargin(b.setDiff) : "none" },
    { key: "clean", label: "Clean wins", side: formEdgeSide(rate(a.clean, a.scored), rate(b.clean, b.scored), a.scored, b.scored, 5), A: a.scored ? a.clean + " of " + a.scored : "none", B: b.scored ? b.clean + " of " + b.scored : "none" },
    { key: "decider", label: "Deciders", side: formEdgeSide(rate(a.decW, a.decN), rate(b.decW, b.decN), a.decN, b.decN, 3), A: fmtRec(a.decW, a.decN), B: fmtRec(b.decW, b.decN) },
    { key: "hot", label: "Last 5", side: formEdgeSide(rate(a.hotW, a.hotN), rate(b.hotW, b.hotN), a.hotN, b.hotN, 5), A: fmtRec(a.hotW, a.hotN), B: fmtRec(b.hotW, b.hotN) }
  ];
}

function recentLead(rows) {
  let a = 0, b = 0;
  for (const r of rows || []) {
    if (r.side === "A") a++;
    else if (r.side === "B") b++;
  }
  return { a, b };
}

// Last-15 rows with the rating each player carried into the match: { won, own, opp }.
// "Higher" means the opponent was rated above this player that day.
function fieldShape(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && Number.isFinite(r.own) && Number.isFinite(r.opp));
  const above = list.filter(r => r.opp > r.own);
  let best = null;
  for (const r of list) if (r.won && (!best || r.opp > best.opp)) best = r;
  const avg = xs => xs.length ? Math.round(xs.reduce((s, n) => s + n, 0) / xs.length) : null;
  return {
    known: list.length,
    aboveN: above.length,
    aboveW: above.filter(r => r.won).length,
    avgGap: above.length ? Math.round(above.reduce((s, r) => s + (r.opp - r.own), 0) / above.length) : null,
    best: best ? best.opp : null,
    bestGap: best ? best.opp - best.own : null,
    avgField: avg(list.map(r => r.opp))
  };
}

function fmtGap(n) { return n > 0 ? "+" + n : n < 0 ? "−" + (-n) : "0"; }

function fieldLines(f) {
  const main = f.aboveN ? fmtRec(f.aboveW, f.aboveN) : "none";
  const parts = [];
  if (f.aboveN && f.avgGap != null) parts.push("+" + f.avgGap + " Elo avg");
  if (f.best != null) parts.push("best win " + f.best + " (" + fmtGap(f.bestGap) + ")");
  if (f.avgField != null) parts.push("opponents " + f.avgField);
  return { main, sub: parts.join(" · ") };
}

// A winning record against stronger opponents leads. A losing one does not,
// and a single upset is too thin to color.
function fieldSide(a, b) {
  const rateA = a.aboveN ? a.aboveW / a.aboveN : null;
  const rateB = b.aboveN ? b.aboveW / b.aboveN : null;
  if (a.aboveN >= 3 && b.aboveN >= 3) return formEdgeSide(rateA, rateB, a.aboveN, b.aboveN, 3);
  if (a.aboveN >= 3 && b.aboveN === 0 && rateA > 0.5) return "A";
  if (b.aboveN >= 3 && a.aboveN === 0 && rateB > 0.5) return "B";
  return "";
}

function fieldStat(a, b) {
  a = a && a.aboveN != null ? a : fieldShape(a);
  b = b && b.aboveN != null ? b : fieldShape(b);
  const la = fieldLines(a), lb = fieldLines(b);
  return { key: "higher", label: "Vs higher", side: fieldSide(a, b), A: la.main, B: lb.main, subA: la.sub, subB: lb.sub };
}

// Recent-window rows where this player carried the higher Elo into the match.
// Even ratings are neither favorite nor underdog. Underdog stays on fieldShape.
function favoriteShape(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && Number.isFinite(r.own) && Number.isFinite(r.opp));
  const fav = list.filter(r => r.own > r.opp);
  return { favN: fav.length, favW: fav.filter(r => r.won).length };
}

function favoriteSide(a, b) {
  if (!(a.favN >= 3) || !(b.favN >= 3)) return "";
  return formEdgeSide(a.favW / a.favN, b.favW / b.favN, a.favN, b.favN, 3);
}

function favoriteStat(a, b) {
  a = a && a.favN != null ? a : favoriteShape(a);
  b = b && b.favN != null ? b : favoriteShape(b);
  return {
    key: "favorite",
    label: "As the favorite",
    side: favoriteSide(a, b),
    A: a.favN ? fmtRec(a.favW, a.favN) : "none",
    B: b.favN ? fmtRec(b.favW, b.favN) : "none"
  };
}

// Session is counted elsewhere (the last 12 hours of matches). This only formats it.
// main is the record. sub is how many matches, plus a losing run when one is already known.
function sessionStat(s) {
  const n = s && s.n ? s.n : 0;
  const w = s && s.w ? s.w : 0;
  const run = s && s.run ? s.run : 0;
  if (!n) return { n: 0, w: 0, main: "none yet", sub: "" };
  let sub = n + " played";
  if (run >= 3) sub += ", lost " + run + " in a row";
  return { n, w, main: fmtRec(w, n), sub };
}

// One label for a sportsbook, so BetMGM and MGM are the same line.
function bookKey(name) {
  const n = String(name || "DraftKings").trim().toLowerCase().replace(/\s+/g, "");
  if (n === "draftkings") return "DraftKings";
  if (n === "fanduel") return "FanDuel";
  if (n === "bet365" || n === "bets365") return "bet365";
  if (n === "mgm" || n === "betmgm") return "MGM";
  if (n === "fanatics") return "Fanatics";
  const raw = String(name || "DraftKings").trim();
  return raw || "DraftKings";
}

// Updating one book replaces only that book's current price.
// Every other book stays, and a changed price stays in the history behind the new one.
function upsertBookPrice(list, row) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const book = bookKey(row && row.book);
  const next = Object.assign({}, row, { book });
  let seen = false;
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (bookKey(v.book) !== book) { out.push(v); continue; }
    const last = arr.slice(i + 1).every(x => bookKey(x.book) !== book);
    if (!last) { out.push(v); continue; }
    seen = true;
    if (v.o1 === next.o1 && v.o2 === next.o2) out.push(Object.assign({}, v, next, { at: v.at || next.at }));
    else { out.push(v); out.push(next); }
  }
  if (!seen) out.push(next);
  return out;
}

// The price on screen for each book. A later line for the same book wins.
function latestByBook(list) {
  const map = new Map();
  for (const v of list || []) {
    const book = bookKey(v.book);
    const prev = map.get(book);
    if (!prev || (v.at || 0) >= (prev.at || 0)) map.set(book, Object.assign({}, v, { book }));
  }
  return map;
}

// Cap how many old prices one book can keep, without dropping a different book.
function trimBookList(list, perBook) {
  const keep = perBook || 4;
  const groups = new Map();
  for (const v of list || []) {
    const book = bookKey(v.book);
    const g = groups.get(book) || [];
    const prev = g[g.length - 1];
    if (prev && prev.o1 === v.o1 && prev.o2 === v.o2) continue;
    g.push(Object.assign({}, v, { book }));
    groups.set(book, g.slice(-keep));
  }
  return [...groups.values()].flat();
}

// The prices a bettor would rather have: the lower implied chance on that player.
// A tie returns every book at that price.
function bestBookSide(rows) {
  const implied = (o) => {
    const n = Number(o);
    if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
    return n < 0 ? (-n) / (-n + 100) : 100 / (n + 100);
  };
  const pick = (key) => {
    let bestP = Infinity;
    let hits = [];
    for (const r of rows || []) {
      const o = Number(r[key]);
      const p = implied(o);
      if (p === null) continue;
      if (p < bestP - 1e-9) { bestP = p; hits = [{ name: r.name, o }]; }
      else if (Math.abs(p - bestP) <= 1e-9) hits.push({ name: r.name, o });
    }
    return hits;
  };
  return { a: pick("oa"), b: pick("ob") };
}

function foldName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z']+/g, " ").trim();
}

// "Maciej Kolek" and "Kolek Maciej" are the same player. A first name shared by two players does not match.
function matchPlayerName(raw, players) {
  const t = foldName(raw);
  const words = t.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 4) return null;
  const list = players || [];
  const exact = list.filter(p => foldName(p.name) === t);
  if (exact.length === 1) return exact[0].name;
  const rev = words.slice().reverse().join(" ");
  const flipped = list.filter(p => foldName(p.name) === rev);
  if (flipped.length === 1) return flipped[0].name;
  const loose = list.filter(p => {
    const n = foldName(p.name).split(" ").filter(Boolean);
    return words.every(w => n.includes(w));
  });
  return loose.length === 1 ? loose[0].name : null;
}

function parseAmerican(raw) {
  const m = String(raw || "").trim().match(/^([+\-\u2212\u2013\u2014])\s?(\d{2,4})$/);
  if (!m) return null;
  const n = +m[2];
  if (!(n >= 100)) return null;
  return (m[1] === "+" ? 1 : -1) * n;
}

function parsePasteClock(line) {
  const m = String(line || "").trim().match(/^(today|tomorrow|tonight)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = +m[2];
  const min = m[3] ? +m[3] : 0;
  const ap = m[4].toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { day: (m[1] || "today").toLowerCase(), minutes: h * 60 + min };
}

// A copied sportsbook page: first name, vs, first name, the two prices, then "Today 2:00 PM".
// A line that is only a book name starts a new book. One book never takes the other's prices.
function parseBookPaste(text, players) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim()).filter(l => l && !/^https?:/i.test(l));
  const known = { draftkings: "DraftKings", fanduel: "FanDuel", bet365: "bet365", bets365: "bet365", mgm: "MGM", betmgm: "MGM", fanatics: "Fanatics" };
  const matches = [];
  const missed = [];
  let book = null;
  let cur = null;
  const flush = () => {
    if (cur && cur.p1 && cur.p2 && cur.p1 !== cur.p2 && cur.o1 != null && cur.o2 != null) matches.push(Object.assign({ book }, cur));
    cur = null;
  };
  const ensure = () => cur || (cur = { p1: null, p2: null, o1: null, o2: null, minutes: null, day: null });
  for (const line of lines) {
    const token = foldName(line).replace(/ /g, "");
    if (known[token]) { book = known[token]; continue; }
    if (/^more bets$/i.test(line)) { flush(); continue; }
    if (/^vs\.?$/i.test(line)) continue;
    const inline = line.match(/^(.*\S)\s+([+\-\u2212\u2013\u2014]\s?\d{2,4})$/);
    if (inline) {
      const who = matchPlayerName(inline[1], players);
      const odd = parseAmerican(inline[2]);
      if (who && odd != null) {
        const c = ensure();
        if (!c.p1) { c.p1 = who; c.o1 = odd; }
        else if (!c.p2) { c.p2 = who; c.o2 = odd; }
        else { flush(); const n = ensure(); n.p1 = who; n.o1 = odd; }
        continue;
      }
    }
    const clock = parsePasteClock(line);
    if (clock && !matchPlayerName(line, players)) {
      const c = ensure();
      c.minutes = clock.minutes;
      c.day = clock.day;
      continue;
    }
    const odd = parseAmerican(line);
    if (odd != null) {
      const c = ensure();
      if (c.o1 == null) c.o1 = odd;
      else if (c.o2 == null) c.o2 = odd;
      else { flush(); const n = ensure(); n.o1 = odd; }
      continue;
    }
    const name = matchPlayerName(line, players);
    if (!name) {
      if (!/^(today|tomorrow|tonight)\b/i.test(line)) missed.push(line);
      continue;
    }
    const c = ensure();
    if (!c.p1) c.p1 = name;
    else if (!c.p2) c.p2 = name;
    else { flush(); const n = ensure(); n.p1 = name; }
  }
  flush();
  return { matches, missed };
}

// The copied clock is the sportsbook's clock. Find the hour shift that lands those times on the schedule.
// date is the schedule day most of the paste agrees on, so yesterday's same clock is not the match.
// When several shifts fit, prefer the one already used for this sportsbook, then the meetings closest to now.
function alignPasteTimes(matches, fixtures, opts) {
  const now = typeof opts === "number" ? opts : (opts && opts.now != null ? opts.now : Date.now());
  const preferOff = opts && typeof opts === "object" && opts.preferOff != null ? opts.preferOff : null;
  const ranked = [];
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    let hits = 0;
    const byDate = new Map();
    for (const m of matches || []) {
      if (m.minutes == null) continue;
      const target = (m.minutes + off + 1440) % 1440;
      const pair = [m.p1, m.p2].sort().join("|");
      let matched = false;
      const dates = new Set();
      for (const f of fixtures || []) {
        if ([f.p1, f.p2].sort().join("|") !== pair || Math.abs(f.minutes - target) > 10) continue;
        matched = true;
        if (f.date) dates.add(f.date);
      }
      if (!matched) continue;
      hits++;
      for (const d of dates) byDate.set(d, (byDate.get(d) || 0) + 1);
    }
    if (!hits) continue;
    let date = null;
    let dateHits = 0;
    let tied = false;
    for (const [d, n] of byDate) {
      if (n > dateHits) { dateHits = n; date = d; tied = false; }
      else if (n === dateHits) tied = true;
    }
    if (tied) date = null;
    let lag = 0;
    let used = 0;
    for (const m of matches || []) {
      if (m.minutes == null) continue;
      const target = (m.minutes + off + 1440) % 1440;
      const pair = [m.p1, m.p2].sort().join("|");
      let bestLag = Infinity;
      for (const f of fixtures || []) {
        if ([f.p1, f.p2].sort().join("|") !== pair || Math.abs(f.minutes - target) > 10) continue;
        if (date && f.date && f.date !== date) continue;
        if (f.at == null) continue;
        const dt = f.at - now;
        const row = dt >= -15 * 60000 ? Math.abs(dt) : 1e12 + Math.abs(dt);
        if (row < bestLag) bestLag = row;
      }
      if (bestLag < Infinity) { lag += bestLag; used++; }
    }
    if (!used) lag = Infinity;
    ranked.push({ off, hits, date, lag });
  }
  if (!ranked.length) return { off: 0, hits: 0, date: null, unique: false };
  const top = Math.max(...ranked.map(r => r.hits));
  const tiedOff = ranked.filter(r => r.hits === top);
  const preferred = preferOff == null ? null : tiedOff.find(r => r.off === preferOff);
  const pick = preferred || tiedOff.reduce((a, b) => b.lag < a.lag ? b : a);
  return { off: pick.off, hits: pick.hits, date: pick.date, unique: tiedOff.length === 1 };
}

// Favorite record over the recent window, for a display flag only. It does not move the win chance.
// sign 1 is playing above Elo, sign -1 is playing below. Ban-list players keep their own flag.
function dataMark(s, onBan) {
  if (onBan || !s) return null;
  const n = s.moN || 0;
  if (n < 8) return null;
  const diff = (s.moW || 0) - (s.moE || 0);
  const rate = diff / n;
  if (rate <= -0.2) return { sign: -1, n, w: s.moW, diff, rate };
  if (rate >= 0.2) return { sign: 1, n, w: s.moW, diff, rate };
  return null;
}

// How old the official results list is. Past 40 minutes, the last match may not be in it yet.
function resultsAge(updatedAt, nowMs) {
  const t = new Date(updatedAt).getTime();
  if (!updatedAt || !Number.isFinite(t)) return null;
  const now = nowMs == null ? Date.now() : nowMs;
  const mins = Math.max(0, Math.round((now - t) / 60000));
  return { mins, stale: mins > 40 };
}

// A flag you set by hand. until 0 means it stays until you clear it. It never moves the win chance.
function activePlayerFlag(flag, nowMs) {
  if (!flag || typeof flag !== "object") return null;
  const reason = String(flag.reason == null ? "" : flag.reason).trim().slice(0, 80);
  if (!reason) return null;
  const now = nowMs == null ? Date.now() : nowMs;
  const until = Number(flag.until);
  const open = !Number.isFinite(until) || until <= 0;
  if (!open && until <= now) return null;
  return { reason, until: open ? 0 : until, at: Number(flag.at) || 0 };
}

function prunePlayerFlags(flags, nowMs) {
  const out = {};
  if (!flags || typeof flags !== "object") return out;
  const now = nowMs == null ? Date.now() : nowMs;
  for (const name of Object.keys(flags)) {
    const live = activePlayerFlag(flags[name], now);
    if (live) out[name] = { reason: live.reason, until: live.until, at: live.at };
  }
  return out;
}

function flagLeft(until, nowMs) {
  const n = Number(until);
  if (!Number.isFinite(n) || n <= 0) return "until you clear it";
  const now = nowMs == null ? Date.now() : nowMs;
  const ms = n - now;
  if (ms <= 0) return "";
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return mins === 1 ? "1 min left" : mins + " min left";
  const hours = Math.round(mins / 60);
  if (hours < 48) return hours === 1 ? "1 h left" : hours + " h left";
  const days = Math.max(2, Math.round(hours / 24));
  return days + " days left";
}

// The phone's own calendar day, so Today starts over at local midnight.
function localDayKey(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function betsOnDay(bets, dayKey) {
  if (!dayKey) return [];
  return (bets || []).filter(b => b && localDayKey(b.made) === dayKey);
}

function betBackupText(bets, savedAt) {
  const at = savedAt == null ? Date.now() : savedAt;
  return JSON.stringify({ v: 1, saved: new Date(at).toISOString(), bets: Array.isArray(bets) ? bets : [] });
}

function parseBetBackup(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return null; }
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.bets) ? data.bets : null);
  if (!arr) return null;
  return arr.filter(b => b && typeof b === "object" && b.id);
}

function impliedProb(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return n < 0 ? (-n) / (-n + 100) : 100 / (n + 100);
}

// The book has the higher rating as the underdog. Display only. It does not move the win chance.
// Higher Elo wins. At the same Elo, the better rank (the lower rank number) wins.
function bookFadesRating(a, b, oa, ob) {
  if (!a || !b) return null;
  const ia = impliedProb(oa), ib = impliedProb(ob);
  if (ia == null || ib == null || ia === ib) return null;
  const bookFav = ia > ib ? "A" : "B";
  let rateFav = null, reason = "";
  if (a.elo !== b.elo) { rateFav = a.elo > b.elo ? "A" : "B"; reason = "elo"; }
  else if (a.rank != null && b.rank != null && a.rank !== b.rank) { rateFav = a.rank < b.rank ? "A" : "B"; reason = "rank"; }
  if (!rateFav || rateFav === bookFav) return null;
  const hi = rateFav === "A" ? a : b;
  const lo = rateFav === "A" ? b : a;
  return { dog: hi.name, fav: lo.name, dogElo: hi.elo, favElo: lo.elo, dogRank: hi.rank, favRank: lo.rank, reason };
}

function pickFixture(match, fixtures, offsetMin, slateDate) {
  const pair = [match.p1, match.p2].sort().join("|");
  const cands = (fixtures || []).filter(f => [f.p1, f.p2].sort().join("|") === pair);
  if (!cands.length) return null;
  const now = Date.now();
  const soonest = cands.slice().sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return Math.abs((a.at || 0) - now) - Math.abs((b.at || 0) - now);
  })[0];
  if (match.minutes == null || offsetMin == null) return soonest;
  const target = (match.minutes + offsetMin + 1440) % 1440;
  const near = [];
  for (const f of cands) {
    let diff = Math.abs(f.minutes - target);
    if (diff > 720) diff = 1440 - diff;
    if (diff <= 20) near.push(f);
  }
  if (!near.length) return soonest;
  const clock = f => {
    let d = Math.abs(f.minutes - target);
    if (d > 720) d = 1440 - d;
    return d;
  };
  near.sort((a, b) => {
    const as = slateDate && a.date === slateDate ? 0 : 1;
    const bs = slateDate && b.date === slateDate ? 0 : 1;
    if (as !== bs) return as - bs;
    if (clock(a) !== clock(b)) return clock(a) - clock(b);
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return (b.at || 0) - (a.at || 0);
  });
  return near[0];
}

// A single day of favorite losses. Display only. It does not move the win chance.
// Crazy means 6+ matches and 5 or more losses while Elo had him over 55%.
function coldSlates(players, todayIso, keepDays) {
  const keep = keepDays == null ? 21 : keepDays;
  const today = String(todayIso || "");
  const cut = new Date(today + "T12:00:00Z");
  if (isNaN(cut.getTime())) return [];
  cut.setUTCDate(cut.getUTCDate() - keep);
  const cutoff = cut.toISOString().slice(0, 10);
  const out = [];
  for (const row of players || []) {
    if (!row || !row.name || !row.days) continue;
    const list = typeof row.days.entries === "function" ? [...row.days.entries()] : Object.entries(row.days);
    let best = null;
    for (const [date, d] of list) {
      if (!d || date < cutoff || date > today) continue;
      const n = d.n || 0;
      const w = d.w || 0;
      const e = +d.e || 0;
      const favL = d.favL || 0;
      const gap = w - e;
      if (n < 6 || favL < 5) continue;
      const item = { name: row.name, date, n, w, e, favL, gap };
      if (!best || item.date > best.date) best = item;
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.favL - a.favL || a.gap - b.gap || (a.name < b.name ? -1 : 1));
  return out.slice(0, 10);
}

// Which player the win chance moved toward, in percentage points, versus Elo.
// Side "A" means the first player's chance went up. Under 4 points stays quiet.
function eloMove(pa, pe) {
  if (pa == null || pe == null || pa !== pa || pe !== pe) return null;
  const diff = pa - pe;
  const pts = Math.round(Math.abs(diff) * 100);
  if (Math.abs(diff) < 0.04 || pts < 1) return null;
  return { side: diff > 0 ? "A" : "B", pts };
}

// Pair one day's schedule rows with that day's official results, both in play order.
// A row takes the next result only after its start time. A rematch that is still
// ahead stays open, so an earlier score cannot land on it once the first listing
// has left the schedule.
function attachPairResults(rows, results, now) {
  const rs = (rows || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  const ms = results || [];
  const out = new Map();
  let j = 0;
  const t = now == null ? Date.now() : now;
  for (const r of rs) {
    if (!r || !(r.at <= t) || !ms[j]) continue;
    out.set(r, ms[j]);
    j++;
  }
  return out;
}

// Add logit shifts to a win probability. An empty list leaves the probability alone.
function blendShifts(p, shifts) {
  if (p == null || p !== p || p <= 0 || p >= 1) return null;
  let z = Math.log(p / (1 - p));
  for (const s of shifts || []) {
    if (s == null || s !== s) continue;
    z += s;
  }
  const out = 1 / (1 + Math.exp(-z));
  return Math.min(0.97, Math.max(0.03, out));
}
