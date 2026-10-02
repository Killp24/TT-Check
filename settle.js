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
