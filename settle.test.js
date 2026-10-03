const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const ctx = { Date, Math, Number };
vm.runInNewContext(readFileSync(__dirname + "/settle.js", "utf8"), ctx);

const { parlayTicketStatus, parlayPayoutOdds, decisionSnapshot, settleParlayLegs, shrunkShift, fitWinCurve, applyWinCurve, recentShift, chooseNudge, bestBlendWeight, logitBlend, fitSessionShifts, sessionBin, pricePairMatch, pairPlusOdds, betOnFlaggedPlus, roiOf } = ctx;

test("a lost leg settles the ticket and leaves the other legs alone", () => {
  const bet = {
    parlay: true,
    status: "pending",
    odds: 250,
    legs: [
      { pick: "A", opp: "B", status: "pending", odds: -150 },
      { pick: "C", opp: "D", status: "pending", odds: 120 },
      { pick: "E", opp: "F", status: "pending", odds: -110 }
    ]
  };
  const results = {
    "A|B": { w: "B", l: "A", score: "3-1", raw: "m1" }
  };
  settleParlayLegs(bet, leg => results[[leg.pick, leg.opp].sort().join("|")] || null);
  assert.equal(bet.status, "lost");
  assert.equal(bet.legs[0].status, "lost");
  assert.equal(bet.legs[1].status, "pending");
  assert.equal(bet.legs[2].status, "pending");
});

test("marking one leg lost does not mark the winning leg lost", () => {
  const legs = [
    { status: "won" },
    { status: "lost" },
    { status: "pending" }
  ];
  assert.equal(parlayTicketStatus(legs), "lost");
  assert.deepEqual(legs.map(l => l.status), ["won", "lost", "pending"]);
});

test("void legs drop out of the ticket instead of losing it", () => {
  assert.equal(parlayTicketStatus([{ status: "void" }, { status: "won" }, { status: "won" }]), "won");
  assert.equal(parlayTicketStatus([{ status: "void" }, { status: "pending" }]), "pending");
  assert.equal(parlayTicketStatus([{ status: "void" }, { status: "void" }]), "void");
  assert.equal(parlayTicketStatus([{ status: "void" }, { status: "lost" }]), "lost");
  assert.equal(parlayTicketStatus([{ status: "won" }, { status: "won" }]), "won");
});

test("a void leg is removed from the payout price", () => {
  const bet = {
    parlay: true,
    odds: 600,
    legs: [
      { status: "void", odds: 150 },
      { status: "won", odds: -110 },
      { status: "won", odds: 120 }
    ]
  };
  assert.equal(parlayPayoutOdds(bet), 320);
  assert.equal(parlayPayoutOdds({ parlay: true, odds: 200, legs: [{ status: "void", odds: 150 }, { status: "won", odds: -140 }] }), -140);
});

test("decision snapshot keeps book odds, app probability, edge, and time", () => {
  const snap = decisionSnapshot(-150, 130, 0.66, 0.34, 1_700_000_000_000);
  assert.equal(snap.at, 1_700_000_000_000);
  assert.equal(snap.o1, -150);
  assert.equal(snap.o2, 130);
  assert.equal(snap.app1, 0.66);
  assert.equal(snap.app2, 0.34);
  assert.equal(typeof snap.edge1, "number");
  assert.equal(typeof snap.edge2, "number");
  assert.ok(snap.edge1 > 0);
});

test("the calibration curve pulls an overconfident favorite down and stays ordered", () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push([0.62, i < 50 ? 1 : 0]);
  for (let i = 0; i < 80; i++) rows.push([0.72, i < 48 ? 1 : 0]);
  for (let i = 0; i < 80; i++) rows.push([0.82, i < 60 ? 1 : 0]);
  const curve = fitWinCurve(rows, 40);
  const lo = applyWinCurve(0.62, curve);
  const mid = applyWinCurve(0.72, curve);
  const hi = applyWinCurve(0.82, curve);
  assert.ok(lo <= mid + 1e-9 && mid <= hi + 1e-9);
  assert.ok(hi < 0.82);
  assert.ok(Math.abs(applyWinCurve(0.18, curve) - (1 - hi)) < 0.03);
});

test("a blowout win counts more than a scrape when margins are used", () => {
  const blow = [];
  const scrape = [];
  for (let i = 0; i < 6; i++) {
    blow.push({ e: 0.5, won: 1, score: "3-0" });
    scrape.push({ e: 0.5, won: 1, score: "3-2" });
  }
  for (let i = 0; i < 6; i++) {
    blow.push({ e: 0.5, won: 0, score: "3-2" });
    scrape.push({ e: 0.5, won: 0, score: "3-0" });
  }
  const a = recentShift(blow, "margin", 80);
  const b = recentShift(scrape, "margin", 80);
  assert.ok(a.shift > 0);
  assert.ok(b.shift < 0);
  assert.equal(recentShift(blow, "plain", 80).shift, 0);
});

test("a nudge is kept only when it lowers the error enough", () => {
  assert.equal(chooseNudge(100, { plain: 99.9, margin: 80 }, 200, 0.001), "margin");
  assert.equal(chooseNudge(100, { plain: 99.9 }, 200, 0.001), "off");
  assert.equal(chooseNudge(100, { plain: 50 }, 40, 0.001), "off");
});

test("the book gets a vote only when the mix beat the app on later matches", () => {
  const helpful = [];
  for (let i = 0; i < 50; i++) {
    const y = i % 2;
    helpful.push({ app: 0.5, book: y ? 0.8 : 0.2, y });
  }
  const fit = bestBlendWeight(helpful);
  assert.equal(fit.ready, true);
  assert.ok(fit.w > 0);
  assert.ok(fit.blendLoss < fit.appLoss);
  const useless = [];
  for (let i = 0; i < 50; i++) {
    const y = i % 2;
    useless.push({ app: y ? 0.8 : 0.2, book: 0.5, y });
  }
  assert.equal(bestBlendWeight(useless).w, 0);
  assert.ok(logitBlend(0.7, 0.4, 0) > 0.69 && logitBlend(0.7, 0.4, 0) < 0.71);
});

test("session shifts need a real sample and ignore the first match of the day", () => {
  assert.equal(sessionBin(0), 0);
  assert.equal(sessionBin(2), 1);
  assert.equal(sessionBin(8), 3);
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ bw: 0, bl: 3, e: 0.4 });
  const shift = fitSessionShifts(rows, 80, 150);
  assert.ok(shift[3] < 0);
  assert.equal(shift[0], undefined);
});

test("the plus side of +102 / −136 is the +102 bet, and only when both prices match", () => {
  assert.equal(pricePairMatch(-136, 102, 102, -136), true);
  assert.equal(pricePairMatch(102, -130, 102, -136), false);
  assert.equal(pairPlusOdds(102, -136), 102);
  assert.equal(pairPlusOdds(-110, -110), null);
  const plus = { odds: 102, stake: 50, status: "won", snap: { o1: -136, o2: 102 } };
  const minus = { odds: -136, stake: 50, status: "won", snap: { o1: 102, o2: -136 } };
  const other = { odds: 102, stake: 50, status: "won", snap: { o1: 102, o2: -120 } };
  const oneSided = { odds: 102, stake: 50, status: "won", snap: { o1: 102, o2: null } };
  assert.equal(betOnFlaggedPlus(plus, 102, -136), true);
  assert.equal(betOnFlaggedPlus(minus, 102, -136), false);
  assert.equal(betOnFlaggedPlus(other, 102, -136), false);
  assert.equal(betOnFlaggedPlus(oneSided, 102, -136), false);
  const s = roiOf([
    plus,
    { odds: 102, stake: 100, status: "lost", snap: { o1: 102, o2: -136 } },
    { odds: 102, stake: 100, status: "pending", snap: { o1: 102, o2: -136 } }
  ]);
  assert.equal(s.won, 1);
  assert.equal(s.lost, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.staked, 150);
  assert.equal(s.profit, -49);
  assert.ok(Math.abs(s.roi - (-49 / 150)) < 1e-9);
});

test("form shift shrinks a small sample toward zero", () => {
  const big = shrunkShift(40, 28, 20, 80);
  const small = shrunkShift(8, 6, 4, 80);
  assert.ok(big > small);
  assert.ok(small > 0);
  assert.equal(shrunkShift(0, 0, 0, 80), 0);
});
