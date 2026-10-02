const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const ctx = { Date, Math, Number };
vm.runInNewContext(readFileSync(__dirname + "/settle.js", "utf8"), ctx);

const { parlayTicketStatus, parlayPayoutOdds, decisionSnapshot, settleParlayLegs, shrunkShift } = ctx;

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

test("form shift shrinks a small sample toward zero", () => {
  const big = shrunkShift(40, 28, 20, 80);
  const small = shrunkShift(8, 6, 4, 80);
  assert.ok(big > small);
  assert.ok(small > 0);
  assert.equal(shrunkShift(0, 0, 0, 80), 0);
});
