// dailypie-core.js — pure DailyPie / Trends logic over scanned message metadata.
// Loaded by dashboard.js (UI) and tests. No browser APIs.

/** Local midnight `daysAgo` days before `now` (negative = future). DST-safe. */
function dayStart(now, daysAgo) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
}

function shiftMonth(ms, months) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + months, d.getDate()).getTime();
}

// Entries are "name@x.com" (exact) or "@x.com" (whole domain).
function matchesPriority(email, prioritySenders) {
  return prioritySenders.some((p) => (p.startsWith("@") ? email.endsWith(p) : email === p));
}

const msgTime = (m) => new Date(m.date).getTime();

/** First time each sender was seen: stored history merged with this window. */
function firstSeenMap(messages, knownSenders = {}) {
  const firstSeen = { ...knownSenders };
  for (const m of messages) {
    const t = msgTime(m);
    if (!(firstSeen[m.senderEmail] <= t)) firstSeen[m.senderEmail] = t;
  }
  return firstSeen;
}

/**
 * Everything the DailyPie home shows for one day (0 = today, 1 = yesterday). The day's mail
 * splits three ways, no guessing: priority senders, first-time senders, and all others.
 */
function computeDailyPie(messages, prefs = {}, now = Date.now(), daysAgo = 0) {
  const { prioritySenders = [] } = prefs;
  const today0 = dayStart(now, daysAgo), dayEnd = dayStart(now, daysAgo - 1);
  const firstSeen = firstSeenMap(messages, prefs.knownSenders);
  const newest = (a, b) => msgTime(b) - msgTime(a);
  const inDay = (t) => t >= today0 && t < dayEnd;
  const today = messages.filter((m) => inDay(msgTime(m))).sort(newest);
  const isPriority = (m) => matchesPriority(m.senderEmail, prioritySenders);
  const isNew = (m) => inDay(firstSeen[m.senderEmail]);

  const newSenders = today.filter((m) => isNew(m) && !isPriority(m));
  const others = today.filter((m) => !isNew(m) && !isPriority(m));

  // Group by sender so ten emails from one sender are one row, not ten.
  const otherGroups = {};
  for (const m of others) (otherGroups[m.senderEmail] ||= { senderEmail: m.senderEmail, senderName: m.senderName, messages: [] }).messages.push(m);

  return {
    stats: {
      total: today.length,
      unread: today.filter((m) => !m.read).length,
      newSenders: new Set(newSenders.map((m) => m.senderEmail)).size,
      others: others.length,
    },
    today,
    others,
    newSenders,
    priority: messages.filter((m) => isPriority(m) && msgTime(m) < dayEnd && (!m.read || msgTime(m) >= today0)).sort(newest),
    otherGroups: Object.values(otherGroups).sort((a, b) => b.messages.length - a.messages.length),
  };
}

/**
 * Trends: last `days` days (including today) vs the period right before it ("period")
 * or the same dates one month earlier ("month"). Returns where to fetch from, so the
 * caller loads exactly the window both ranges need.
 */
function trendRanges(days, compare, now = Date.now()) {
  const curFrom = dayStart(now, days - 1), curTo = dayStart(now, -1);
  const prev = compare === "month"
    ? [shiftMonth(curFrom, -1), shiftMonth(curTo, -1)]
    : [dayStart(now, 2 * days - 1), curFrom];
  return { cur: [curFrom, curTo], prev, fetchFrom: Math.min(curFrom, prev[0]) };
}

function computeTrends(messages, days, compare, prefs = {}, now = Date.now()) {
  const { cur, prev } = trendRanges(days, compare, now);
  const firstSeen = firstSeenMap(messages, prefs.knownSenders);
  const inRange = ([from, to]) => messages.filter((m) => msgTime(m) >= from && msgTime(m) < to);
  const summarize = (list, [from]) => ({
    total: list.length,
    unread: list.filter((m) => !m.read).length,
    senders: new Set(list.map((m) => m.senderEmail)).size,
    newSenders: new Set(list.filter((m) => firstSeen[m.senderEmail] >= from).map((m) => m.senderEmail)).size,
  });
  const perDay = (list, from) => Array.from({ length: days }, (_, i) => {
    const a = dayStart(from, -i), b = dayStart(from, -i - 1);
    return list.filter((m) => msgTime(m) >= a && msgTime(m) < b).length;
  });
  const curList = inRange(cur), prevList = inRange(prev);
  const countBy = (list) => list.reduce((o, m) => ((o[m.senderEmail] = (o[m.senderEmail] || 0) + 1), o), {});
  const curBy = countBy(curList), prevBy = countBy(prevList);
  return {
    current: summarize(curList, cur),
    previous: summarize(prevList, prev),
    days: Array.from({ length: days }, (_, i) => dayStart(cur[0], -i)),
    currentPerDay: perDay(curList, cur[0]),
    previousPerDay: perDay(prevList, prev[0]),
    topSenders: Object.entries(curBy).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([email, n]) => ({ email, current: n, previous: prevBy[email] || 0 })),
  };
}

if (typeof module !== "undefined") {
  module.exports = { dayStart, matchesPriority, computeDailyPie, trendRanges, computeTrends };
}
