// Run from repo root: node --test "THUNDERBIRD/tests/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const { computeDailyPie, computeTrends, trendRanges } = require("../dashboard/dailypie-core.js");

const NOW = new Date(2026, 10, 3, 15, 0).getTime(); // Tue 3 Nov 2026, 3pm local
const at = (daysAgo, h = 10) => new Date(2026, 10, 3 - daysAgo, h);
const ms = (daysAgo) => new Date(2026, 10, 3 - daysAgo).getTime();
let id = 0;
const msg = (senderEmail, date, extra = {}) => ({
  id: ++id, senderEmail, senderName: "", domain: senderEmail.split("@")[1], subject: `topic ${"abcdefghijklmnopqrstuvwxyz"[id % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(id / 26) % 26]}`, date, read: true, ...extra,
});

test("new senders: never seen before, by exact address", () => {
  const msgs = [
    msg("old@a.com", at(0)),            // seen long ago per stored history
    msg("fresh@b.com", at(0)),          // never seen anywhere
    msg("week@c.com", at(3)), msg("week@c.com", at(0)), // seen earlier this window
  ];
  const dp = computeDailyPie(msgs, { knownSenders: { "old@a.com": ms(400) } }, NOW);
  assert.deepEqual(dp.newSenders.map((m) => m.senderEmail), ["fresh@b.com"]);
});

test("the day splits into priority, new senders and all others — no guessing", () => {
  const msgs = [
    msg("boss@acme.com", at(0), { read: false }),          // priority (domain match)
    msg("newhire@acme.com", at(0)),                        // priority AND first-time → priority only
    msg("x@notacme.com", at(0)),                           // look-alike domain, first time → new
    msg("no-reply@shop.com", at(0)),                       // first time → new (automated or not)
    msg("ceo@corp.com", at(0)), msg("ceo@corp.com", at(0)), // known, not priority → all others
  ];
  const dp = computeDailyPie(msgs, { prioritySenders: ["@acme.com"], knownSenders: { "boss@acme.com": ms(90), "ceo@corp.com": ms(90) } }, NOW);
  assert.deepEqual(dp.priority.map((m) => m.senderEmail).sort(), ["boss@acme.com", "newhire@acme.com"]);
  assert.deepEqual(dp.newSenders.map((m) => m.senderEmail).sort(), ["no-reply@shop.com", "x@notacme.com"]);
  assert.deepEqual(dp.otherGroups.map((g) => [g.senderEmail, g.messages.length]), [["ceo@corp.com", 2]]);
  assert.equal(dp.stats.others, 2);
  assert.equal(dp.stats.total, dp.newSenders.length + dp.others.length + 2);
});

test("trends: previous period and same dates last month", () => {
  const r = trendRanges(7, "period", NOW);
  assert.equal(r.cur[0], ms(6));
  assert.equal(r.prev[0], ms(13));
  assert.equal(r.prev[1], ms(6));
  const m = trendRanges(1, "month", NOW);
  assert.equal(m.prev[0], new Date(2026, 9, 3).getTime());

  const msgs = [msg("a@a.com", at(0)), msg("a@a.com", at(6)), msg("b@b.com", at(7)), msg("c@c.com", at(13)), msg("d@d.com", at(14))];
  const tr = computeTrends(msgs, 7, "period", {}, NOW);
  assert.equal(tr.current.total, 2);
  assert.equal(tr.previous.total, 2);
  assert.deepEqual(tr.currentPerDay, [1, 0, 0, 0, 0, 0, 1]);
  assert.equal(tr.topSenders[0].email, "a@a.com");
});

test("yesterday: only yesterday's mail, and new = first seen yesterday", () => {
  const msgs = [
    msg("first@y.com", at(1), { read: false }), // first ever email, yesterday
    msg("first@y.com", at(0)),                   // same sender again today: not new today
    msg("other@z.com", at(0)),                   // today only
  ];
  const y = computeDailyPie(msgs, {}, NOW, 1);
  assert.equal(y.stats.total, 1);
  assert.deepEqual(y.newSenders.map((m) => m.senderEmail), ["first@y.com"]);
  assert.equal(y.stats.unread, 1);
  const t = computeDailyPie(msgs, {}, NOW, 0);
  assert.equal(t.stats.total, 2);
  assert.deepEqual(t.newSenders.map((m) => m.senderEmail), ["other@z.com"]);
});

test("any past day: counts only that day, new = first seen that day", () => {
  const msgs = [
    msg("early@x.com", at(25)),
    msg("early@x.com", at(20)),          // seen before → not new on day 20
    msg("first@x.com", at(20), { read: false }),
    msg("later@x.com", at(19)),          // the day after → excluded
  ];
  const d = computeDailyPie(msgs, {}, NOW, 20);
  assert.equal(d.stats.total, 2);
  assert.deepEqual(d.newSenders.map((m) => m.senderEmail), ["first@x.com"]);
});
