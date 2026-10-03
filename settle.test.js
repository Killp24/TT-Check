const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const ctx = { Date, Math, Number };
vm.runInNewContext(readFileSync(__dirname + "/settle.js", "utf8"), ctx);

const { parlayTicketStatus, parlayPayoutOdds, decisionSnapshot, settleParlayLegs, shrunkShift, fitWinCurve, applyWinCurve, recentShift, chooseNudge, bestBlendWeight, logitBlend, fitSessionShifts, sessionBin, bothPrices, pricePairMatch, pairPlusOdds, betOnFlaggedPlus, roiOf, setsFromScore, recentShape, formEdgeSide, recentStatRows, recentLead, fieldShape, fieldSide, fieldStat, favoriteShape, favoriteSide, favoriteStat, sessionStat, bookKey, upsertBookPrice, latestByBook, trimBookList, bestBookSide, matchPlayerName, parseBookPaste, alignPasteTimes, pickFixture } = ctx;

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

test("a saved line needs both prices, and +102 / −135 is not +102 / −136", () => {
  assert.equal(bothPrices(102, -135), true);
  assert.equal(bothPrices(-136, 102), true);
  assert.equal(bothPrices(102, null), false);
  assert.equal(bothPrices(null, -136), false);
  assert.equal(bothPrices(102, undefined), false);
  assert.equal(bothPrices(99, -136), false);
  assert.equal(pricePairMatch(102, -135, 102, -136), false);
});

test("the plus side of +102 / −136 counts, including older tickets that only saved +102", () => {
  assert.equal(pricePairMatch(-136, 102, 102, -136), true);
  assert.equal(pricePairMatch(102, -130, 102, -136), false);
  assert.equal(pairPlusOdds(102, -136), 102);
  assert.equal(pairPlusOdds(-110, -110), null);
  const plus = { odds: 102, stake: 50, status: "won", snap: { o1: -136, o2: 102 } };
  const minus = { odds: -136, stake: 50, status: "won", snap: { o1: 102, o2: -136 } };
  const other = { odds: 102, stake: 50, status: "won", snap: { o1: 102, o2: -120 } };
  const oneSided = { odds: 102, stake: 39.74, status: "lost", snap: { o1: 102, o2: null } };
  const plusOnly = { odds: 102, stake: 50, status: "won" };
  const wrongPair = { odds: 102, stake: 20, status: "won", flagPair: [102, -120], snap: { o1: 102, o2: null } };
  assert.equal(betOnFlaggedPlus(plus, 102, -136), true);
  assert.equal(betOnFlaggedPlus(minus, 102, -136), false);
  assert.equal(betOnFlaggedPlus(other, 102, -136), false);
  assert.equal(betOnFlaggedPlus(oneSided, 102, -136), true);
  assert.equal(betOnFlaggedPlus(plusOnly, 102, -136), true);
  assert.equal(betOnFlaggedPlus(wrongPair, 102, -136), false);
  const confirmed = roiOf([
    { odds: 102, stake: 100, status: "won", snap: { o1: 102, o2: -136 } },
    oneSided,
    plusOnly,
    { odds: 102, stake: 30, status: "won", snap: { o1: 102 } },
    { odds: 102, stake: 30, status: "won", snap: { o1: 102 } }
  ]);
  assert.equal(confirmed.won, 4);
  assert.equal(confirmed.lost, 1);
  assert.ok(Math.abs(confirmed.staked - 249.74) < 0.001);
  assert.ok(Math.abs(confirmed.profit - 174.46) < 0.001);
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

test("last-15 form colors the better number and leaves a thin sample plain", () => {
  const sets = setsFromScore("3-1");
  assert.equal(sets.won, 3);
  assert.equal(sets.lost, 1);
  assert.equal(setsFromScore("1-3"), null);
  assert.equal(setsFromScore(""), null);
  const hot = [];
  for (let i = 0; i < 5; i++) hot.push({ won: true, score: "3-0" });
  for (let i = 0; i < 5; i++) hot.push({ won: true, score: "3-1" });
  for (let i = 0; i < 5; i++) hot.push({ won: i < 2, score: i < 2 ? "3-2" : "3-0" });
  const cold = [];
  for (let i = 0; i < 5; i++) cold.push({ won: false, score: "3-1" });
  for (let i = 0; i < 4; i++) cold.push({ won: false, score: "3-2" });
  for (let i = 0; i < 6; i++) cold.push({ won: true, score: "3-2" });
  const rows = recentStatRows(recentShape(hot), recentShape(cold));
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.equal(by.wins.side, "A");
  assert.equal(by.wins.A, "12–3");
  assert.equal(by.wins.B, "6–9");
  assert.equal(by.margin.side, "A");
  assert.equal(by.clean.side, "A");
  assert.equal(by.hot.A, "5–0");
  assert.equal(by.hot.side, "A");
  assert.equal(recentLead(rows).a, 4);
  const sameWins = recentStatRows(
    recentShape([{ won: true, score: "3-0" }, { won: true, score: "3-0" }, { won: true, score: "3-0" }, { won: false, score: "3-0" }, { won: false, score: "3-1" }]),
    recentShape([{ won: true, score: "3-2" }, { won: true, score: "3-2" }, { won: true, score: "3-2" }, { won: false, score: "3-2" }, { won: false, score: "3-0" }])
  );
  const tied = Object.fromEntries(sameWins.map(r => [r.key, r]));
  assert.equal(tied.wins.side, "");
  assert.equal(tied.margin.side, "A");
  assert.equal(tied.margin.B.startsWith("−") || tied.margin.B.startsWith("-"), true);
  const thin = recentStatRows(recentShape([{ won: true, score: "3-0" }, { won: true, score: "3-0" }]), recentShape(cold));
  assert.equal(thin.every(r => r.side === ""), true);
  const dec = recentStatRows(
    recentShape([{ won: true, score: "3-2" }, { won: true, score: "3-2" }, { won: true, score: "3-2" }, { won: false, score: "3-2" }].concat(hot.slice(0, 11))),
    recentShape([{ won: false, score: "3-2" }, { won: false, score: "3-2" }, { won: false, score: "3-2" }, { won: true, score: "3-2" }].concat(cold.slice(0, 11)))
  );
  assert.equal(dec.find(r => r.key === "decider").side, "A");
  assert.equal(formEdgeSide(0.5, 0.5, 10, 10, 5), "");
  assert.equal(formEdgeSide(0.8, 0.4, 4, 15, 5), "");
});

test("vs higher names how strong the opponents were", () => {
  const up = [
    { won: true, own: 1200, opp: 1400 },
    { won: true, own: 1200, opp: 1400 },
    { won: true, own: 1200, opp: 1400 },
    { won: false, own: 1200, opp: 1500 }
  ];
  for (let i = 0; i < 4; i++) up.push({ won: true, own: 1200, opp: 1000 });
  const soft = [];
  for (let i = 0; i < 8; i++) soft.push({ won: true, own: 1200, opp: 900 });
  const fa = fieldShape(up), fb = fieldShape(soft);
  assert.equal(fa.aboveW, 3);
  assert.equal(fa.aboveN, 4);
  assert.equal(fa.best, 1400);
  assert.equal(fa.bestGap, 200);
  assert.equal(fb.aboveN, 0);
  assert.equal(fb.best, 900);
  const row = fieldStat(fa, fb);
  assert.equal(row.side, "A");
  assert.equal(row.A, "3–1");
  assert.equal(row.B, "none");
  assert.equal(row.subA.includes("+225 Elo avg"), true);
  assert.equal(row.subA.includes("best win 1400 (+200)"), true);
  assert.equal(row.subB.includes("best win 900"), true);
  assert.equal(row.subB.includes("opponents 900"), true);
  const fought = fieldShape([
    { won: true, own: 1200, opp: 1300 },
    { won: true, own: 1200, opp: 1300 },
    { won: false, own: 1200, opp: 1300 },
    { won: false, own: 1200, opp: 1300 },
    { won: false, own: 1200, opp: 1300 }
  ]);
  assert.equal(fieldSide(fa, fought), "A");
  const one = fieldShape([{ won: true, own: 1000, opp: 1100 }]);
  assert.equal(fieldSide(one, fb), "");
  const lose = fieldShape([
    { won: false, own: 1200, opp: 1400 },
    { won: false, own: 1200, opp: 1400 },
    { won: false, own: 1200, opp: 1400 },
    { won: true, own: 1200, opp: 1400 }
  ]);
  assert.equal(fieldSide(lose, fb), "");
  assert.equal(fieldShape([{ won: true, own: null, opp: 1400 }]).known, 0);
});

test("favorite record uses the recent window when Elo was higher", () => {
  const rows = [
    { won: true, own: 1500, opp: 1400 },
    { won: true, own: 1500, opp: 1400 },
    { won: false, own: 1500, opp: 1400 },
    { won: true, own: 1400, opp: 1500 },
    { won: true, own: 1500, opp: 1500 }
  ];
  const shape = favoriteShape(rows);
  assert.equal(shape.favN, 3);
  assert.equal(shape.favW, 2);
  assert.equal(favoriteShape([{ won: true, own: null, opp: 1400 }]).favN, 0);
  const none = favoriteShape([
    { won: true, own: 1000, opp: 1200 },
    { won: false, own: 1000, opp: 1200 },
    { won: true, own: 1000, opp: 1200 }
  ]);
  const thin = favoriteStat(shape, none);
  assert.equal(thin.label, "As the favorite");
  assert.equal(thin.A, "2–1");
  assert.equal(thin.B, "none");
  assert.equal(thin.side, "");
  const hotter = favoriteShape([
    { won: true, own: 1600, opp: 1400 },
    { won: true, own: 1600, opp: 1400 },
    { won: true, own: 1600, opp: 1400 },
    { won: false, own: 1600, opp: 1400 }
  ]);
  const lead = favoriteStat(hotter, shape);
  assert.equal(lead.A, "3–1");
  assert.equal(lead.B, "2–1");
  assert.equal(lead.side, "A");
  assert.equal(favoriteSide(shape, none), "");
});

test("session line counts the matches and keeps the record", () => {
  const s = sessionStat({ n: 5, w: 3, run: 0 });
  assert.equal(s.n, 5);
  assert.equal(s.main, "3–2");
  assert.equal(s.sub, "5 played");
  const cold = sessionStat({ n: 4, w: 1, run: 3 });
  assert.equal(cold.main, "1–3");
  assert.equal(cold.sub, "4 played, lost 3 in a row");
  assert.equal(sessionStat(null).main, "none yet");
  assert.equal(sessionStat(null).sub, "");
  assert.equal(sessionStat({ n: 0, w: 0, run: 4 }).main, "none yet");
});

test("form shift shrinks a small sample toward zero", () => {
  const big = shrunkShift(40, 28, 20, 80);
  const small = shrunkShift(8, 6, 4, 80);
  assert.ok(big > small);
  assert.ok(small > 0);
  assert.equal(shrunkShift(0, 0, 0, 80), 0);
});

test("saving one sportsbook leaves the other books in place", () => {
  let list = [];
  list = upsertBookPrice(list, { book: "DraftKings", o1: -136, o2: 102, at: 1 });
  list = upsertBookPrice(list, { book: "FanDuel", o1: -150, o2: 120, at: 2 });
  list = upsertBookPrice(list, { book: "BetMGM", o1: -145, o2: 115, at: 3 });
  const latest = latestByBook(list);
  assert.equal(latest.get("DraftKings").o1, -136);
  assert.equal(latest.get("FanDuel").o2, 120);
  assert.equal(latest.get("MGM").o1, -145);
  list = upsertBookPrice(list, { book: "FanDuel", o1: -155, o2: 125, at: 4 });
  const again = latestByBook(list);
  assert.equal(again.get("DraftKings").o1, -136);
  assert.equal(again.get("DraftKings").o2, 102);
  assert.equal(again.get("FanDuel").o1, -155);
  assert.equal(again.get("MGM").o1, -145);
  const oldFan = list.filter(v => bookKey(v.book) === "FanDuel");
  assert.equal(oldFan.length, 2);
  assert.equal(oldFan[0].o1, -150);
  const flooded = [];
  let hist = list.slice();
  for (let i = 0; i < 30; i++) hist = upsertBookPrice(hist, { book: "DraftKings", o1: -130 - i, o2: 100 + i, at: 10 + i });
  const kept = trimBookList(hist, 4);
  assert.equal(latestByBook(kept).get("FanDuel").o1, -155);
  assert.equal(latestByBook(kept).get("MGM").o2, 115);
  assert.equal(latestByBook(kept).get("DraftKings").o2, 129);
  assert.ok(kept.filter(v => bookKey(v.book) === "DraftKings").length <= 4);
});

test("the best number is the price a bettor would rather take", () => {
  const best = bestBookSide([
    { name: "DraftKings", oa: -136, ob: 102 },
    { name: "FanDuel", oa: -150, ob: 120 },
    { name: "MGM", oa: -145, ob: 115 }
  ]);
  assert.equal(best.a.length, 1);
  assert.equal(best.a[0].name, "DraftKings");
  assert.equal(best.a[0].o, -136);
  assert.equal(best.b[0].name, "FanDuel");
  assert.equal(best.b[0].o, 120);
  const tied = bestBookSide([
    { name: "DraftKings", oa: -136, ob: 102 },
    { name: "FanDuel", oa: -136, ob: 102 }
  ]);
  assert.equal(tied.a.length, 2);
  assert.equal(tied.b.length, 2);
});

test("a copied sportsbook page keeps each matchup and can name the book", () => {
  const players = [
    "Kolek Maciej", "Makajew Maciej", "Pyrek Dawid", "Karpiuk Mateusz", "Szymik Robert", "Sawicki Grzegorz",
    "Trela Mateusz", "Mugowski Arkadiusz", "Baran Mateusz", "Baran Sebastian", "Kubiak Artur", "Gesiarz Piotr",
    "Fomin Andriej", "Fomin Yurij", "Kukawka Milosz", "Brud Szymon", "Sulkowski Karol", "Sulkowski Bartek",
    "Poloszczanski Dawid", "Maszczynski Dariusz", "Mucha Grzegorz"
  ].map(name => ({ name }));
  const text = [
    "FanDuel",
    "Maciej Kolek", "vs", "Maciej Makajew", "", "\u2212215", "", "+150", "Today 2:00 PM", "More Bets",
    "Dawid Pyrek", "vs", "Mateusz Karpiuk", "", "+125", "", "\u2212185", "Today 2:00 PM", "More Bets",
    "Robert Szymik", "vs", "Grzegorz Sawicki", "", "\u2212575", "", "+350", "Today 2:05 PM", "More Bets",
    "Mateusz Trela", "vs", "Arkadiusz Mugowski", "", "+140", "", "\u2212200", "Today 2:05 PM", "More Bets",
    "Mateusz Baran", "vs", "Artur Kubiak", "", "+110", "", "\u2212165", "Today 2:10 PM", "More Bets",
    "Piotr Gesiarz", "vs", "Andriej Fomin", "", "+150", "", "\u2212215", "Today 2:20 PM", "More Bets",
    "Milosz Kukawka", "vs", "Szymon Brud", "", "\u2212105", "", "\u2212135", "Today 2:25 PM", "More Bets",
    "Karol Sulkowski", "vs", "Dawid Poloszczanski", "", "\u2212165", "", "+110", "Today 2:30 PM", "More Bets",
    "Dariusz Maszczynski", "vs", "Grzegorz Mucha", "", "+350", "", "\u2212575", "Today 2:45 PM", "More Bets"
  ].join("\n");
  const parsed = parseBookPaste(text, players);
  assert.equal(parsed.missed.length, 0);
  assert.equal(parsed.matches.length, 9);
  assert.equal(parsed.matches[0].p1, "Kolek Maciej");
  assert.equal(parsed.matches[0].p2, "Makajew Maciej");
  assert.equal(parsed.matches[0].o1, -215);
  assert.equal(parsed.matches[0].o2, 150);
  assert.equal(parsed.matches[0].minutes, 14 * 60);
  assert.equal(parsed.matches[0].book, "FanDuel");
  assert.equal(parsed.matches[4].p1, "Baran Mateusz");
  assert.equal(parsed.matches[4].p2, "Kubiak Artur");
  assert.equal(parsed.matches[6].o1, -105);
  assert.equal(parsed.matches[6].o2, -135);
  assert.equal(parsed.matches[7].p1, "Sulkowski Karol");
  assert.equal(matchPlayerName("Maciej Kolek", players), "Kolek Maciej");
  assert.equal(matchPlayerName("Maciej", players), null);
  const fixtures = [
    { p1: "Makajew Maciej", p2: "Kolek Maciej", minutes: 22 * 60 + 30, at: 1 },
    { p1: "Kolek Maciej", p2: "Makajew Maciej", minutes: 23 * 60, at: 2 },
    { p1: "Pyrek Dawid", p2: "Karpiuk Mateusz", minutes: 23 * 60, at: 2 },
    { p1: "Szymik Robert", p2: "Sawicki Grzegorz", minutes: 23 * 60 + 5, at: 3 }
  ];
  const aligned = alignPasteTimes(parsed.matches.slice(0, 3), fixtures);
  assert.equal(aligned.hits, 3);
  assert.equal(aligned.off, 9 * 60);
  const picked = pickFixture(parsed.matches[0], fixtures, aligned.off);
  assert.equal(picked.minutes, 23 * 60);
});

test("any list in that copied shape is read, and yesterday's clock does not take the slate", () => {
  const players = [
    "Nowak Adam", "Kowal Ewa", "Kolek Maciej", "Makajew Maciej", "Kukawka Milosz", "Brud Szymon",
    "Sulkowski Karol", "Poloszczanski Dawid"
  ].map(name => ({ name }));
  const one = parseBookPaste([
    "Adam Nowak", "vs", "Ewa Kowal", "", "+140", "", "\u2212180", "Today 4:10 PM", "More Bets"
  ].join("\n"), players);
  assert.equal(one.missed.length, 0);
  assert.equal(one.matches.length, 1);
  assert.equal(one.matches[0].p1, "Nowak Adam");
  assert.equal(one.matches[0].p2, "Kowal Ewa");
  assert.equal(one.matches[0].o1, 140);
  assert.equal(one.matches[0].o2, -180);
  assert.equal(one.matches[0].minutes, 16 * 60 + 10);
  assert.equal(one.matches[0].book, null);
  const parsed = parseBookPaste([
    "Maciej Kolek", "vs", "Maciej Makajew", "", "\u2212215", "", "+150", "Today 2:00 PM", "More Bets",
    "Milosz Kukawka", "vs", "Szymon Brud", "", "\u2212105", "", "\u2212135", "Today 2:25 PM", "More Bets",
    "Karol Sulkowski", "vs", "Dawid Poloszczanski", "", "\u2212165", "", "+110", "Today 2:30 PM", "More Bets"
  ].join("\n"), players);
  const fixtures = [
    { p1: "Kolek Maciej", p2: "Makajew Maciej", date: "2026-10-03", minutes: 23 * 60, at: 30, time: "23:00" },
    { p1: "Kukawka Milosz", p2: "Brud Szymon", date: "2026-10-02", minutes: 23 * 60 + 20, at: 10, time: "23:20" },
    { p1: "Kukawka Milosz", p2: "Brud Szymon", date: "2026-10-03", minutes: 23 * 60 + 25, at: 20, time: "23:25" },
    { p1: "Sulkowski Karol", p2: "Poloszczanski Dawid", date: "2026-10-02", minutes: 23 * 60 + 30, at: 11, time: "23:30" },
    { p1: "Sulkowski Karol", p2: "Poloszczanski Dawid", date: "2026-10-03", minutes: 23 * 60 + 30, at: 21, time: "23:30" },
    { p1: "Sulkowski Karol", p2: "Poloszczanski Dawid", date: "2026-10-04", minutes: 23 * 60 + 30, at: 41, time: "23:30" }
  ];
  const aligned = alignPasteTimes(parsed.matches, fixtures);
  assert.equal(aligned.off, 9 * 60);
  assert.equal(aligned.date, "2026-10-03");
  const kuk = pickFixture(parsed.matches[1], fixtures, aligned.off, aligned.date);
  assert.equal(kuk.date + " " + kuk.time, "2026-10-03 23:25");
  const sul = pickFixture(parsed.matches[2], fixtures, aligned.off, aligned.date);
  assert.equal(sul.date + " " + sul.time, "2026-10-03 23:30");
  const finished = fixtures.map(f => Object.assign({}, f, { done: f.date === "2026-10-03" && f.time === "23:25" }));
  const still = pickFixture(parsed.matches[1], finished, aligned.off, aligned.date);
  assert.equal(still.date + " " + still.time, "2026-10-03 23:25");
});

test("a short paste keeps the sportsbook clock from the last full list", () => {
  const players = ["Kolek Maciej", "Makajew Maciej"].map(name => ({ name }));
  const parsed = parseBookPaste([
    "Maciej Kolek", "vs", "Maciej Makajew", "", "\u2212215", "", "+150", "Today 2:00 PM", "More Bets"
  ].join("\n"), players);
  const now = Date.parse("2026-10-03T20:40:00Z");
  const fixtures = [
    { p1: "Makajew Maciej", p2: "Kolek Maciej", date: "2026-10-03", minutes: 22 * 60 + 30, at: Date.parse("2026-10-03T20:30:00Z"), time: "22:30" },
    { p1: "Kolek Maciej", p2: "Makajew Maciej", date: "2026-10-03", minutes: 23 * 60, at: Date.parse("2026-10-03T21:00:00Z"), time: "23:00" }
  ];
  const nearer = alignPasteTimes(parsed.matches, fixtures, { now });
  assert.equal(nearer.unique, false);
  assert.equal(nearer.off, 8 * 60 + 30);
  const remembered = alignPasteTimes(parsed.matches, fixtures, { now, preferOff: 9 * 60 });
  assert.equal(remembered.off, 9 * 60);
  assert.equal(pickFixture(parsed.matches[0], fixtures, remembered.off, remembered.date).time, "23:00");
});
