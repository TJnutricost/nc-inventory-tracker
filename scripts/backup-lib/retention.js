// Which database dumps to keep (pure). Dump keys are `db/nc-YYYYMMDDTHHMMSSZ.dump.enc` (UTC; plain `.dump` keys of an older run are still recognised). The newest dump of each of the last 14 days, the
// newest of each of the last 8 ISO weeks and the newest of each of the last 6 months are kept; everything else matching the dump pattern
// is pruned. The newest dump overall is ALWAYS kept, and a key that does not match the pattern is never touched.
const DUMP_KEY = /^db\/nc-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump(?:\.enc)?$/;
const KEEP = { days: 14, weeks: 8, months: 6 };

const parseDumpKey = (key) => {
  const m = DUMP_KEY.exec(key);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
};
const dumpKey = (date) => `db/nc-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump.enc`;

// ISO week label (year-Www) of a UTC date.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// -> { keep: [keys], prune: [keys] } over the dump keys in `keys` (others are ignored).
function planRetention(keys, now = new Date(), keepRule = KEEP) {
  const dumps = keys.map((key) => ({ key, at: parseDumpKey(key) })).filter((d) => d.at).sort((a, b) => b.at - a.at); // newest first
  const keep = new Set();
  if (dumps.length) keep.add(dumps[0].key);
  const bucketed = (label, limit) => {
    const seen = new Set();
    for (const d of dumps) { const l = label(d.at); if (!seen.has(l) && seen.size < limit) { seen.add(l); keep.add(d.key); } }
  };
  // "the last N days" counts days that HAVE a dump going back from now, so a gap (a missed week) does not shrink the history
  bucketed((d) => d.toISOString().slice(0, 10), keepRule.days);
  bucketed(isoWeek, keepRule.weeks);
  bucketed((d) => d.toISOString().slice(0, 7), keepRule.months);
  return { keep: dumps.filter((d) => keep.has(d.key)).map((d) => d.key), prune: dumps.filter((d) => !keep.has(d.key)).map((d) => d.key) };
}

module.exports = { KEEP, DUMP_KEY, parseDumpKey, dumpKey, planRetention };
