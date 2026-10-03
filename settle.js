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

// A single bet on the plus side of this exact pair. The other side has to be on the bet too.
function betOnFlaggedPlus(bet, a, b) {
  if (!bet || bet.parlay) return false;
  const plus = pairPlusOdds(a, b);
  if (plus == null || Number(bet.odds) !== plus) return false;
  const s = bet.snap;
  if (s && s.o1 != null && s.o2 != null && pricePairMatch(s.o1, s.o2, a, b)) return true;
  return Array.isArray(bet.flagPair) && pricePairMatch(bet.flagPair[0], bet.flagPair[1], a, b);
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
