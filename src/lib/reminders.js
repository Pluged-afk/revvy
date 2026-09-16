// Pure reminder-eligibility for the daily closed-app push cron. This is the
// tested reference; api/study.js keeps an inlined copy (so its bundle never
// depends on importing across the api/ boundary) -- keep the two in sync. A
// subscribed learner is worth a nudge when they have cards due for review now.
// Reviews-due is the trigger because it is always actionable and timezone
// independent; the streak is surfaced in the copy but never the sole reason (a
// single daily UTC cron can't reason about "streak about to break at midnight
// local"). The cron dedups to once per UTC day via each sub's last_notified.
export function reminderFor(blob, nowMs = Date.now()) {
  const b = blob && typeof blob === "object" ? blob : {};
  const cards = Array.isArray(b.cards) ? b.cards : [];
  const dueCount = cards.filter((c) => c && typeof c.due === "number" && c.due <= nowMs).length;
  const streak = Math.max(0, Math.round(Number(b.stats?.streak) || 0));
  return { send: dueCount > 0, dueCount, streak };
}

// Build the (English, by default) notification body from an eligibility result.
// Kept translation-ready via the optional `t` map even though the cron sends
// English for now (a closed push can't read the client's live language).
export function reminderText(info, t = {}) {
  const due = Math.max(0, Math.round(Number(info?.dueCount) || 0));
  const base = due === 1
    ? (t.pushDueOne || "1 review is due. Keep it fresh.")
    : (t.pushDueMany || "{n} reviews are due. Keep them fresh.").replace("{n}", due);
  if (info && info.streak > 0) {
    return (t.pushStreak || "{msg} Don't lose your {d}-day streak.").replace("{msg}", base).replace("{d}", info.streak);
  }
  return base;
}
