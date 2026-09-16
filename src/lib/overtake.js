// Pure decision logic for the friend-overtake nudge, split out so it can be
// unit-tested; the effect that drives it (polling, toast, blob write) lives in
// the component. Given each friend's public XP, your own live XP, and the
// persisted overtake state, it works out who is ahead of you now, which
// crossings are FRESH (worth a nudge), and whether anything changed at all so
// the caller only writes the study blob when the standings actually shift.
//
// `aheadInit` is a one-time seed latch: until it is set, we only establish a
// baseline and never nudge, so an existing user syncing for the first time
// after this ships never gets a false "everyone just passed you".
export function detectOvertakes({ friendsXp, myXP, seenAhead, aheadInit } = {}) {
  const list = Array.isArray(friendsXp) ? friendsXp : [];
  const myx = Number(myXP) || 0;
  const seen = new Set((Array.isArray(seenAhead) ? seenAhead : []).map(String));
  const ahead = list.filter((f) => f && typeof f.xp === "number" && f.xp > myx);
  const aheadIds = ahead.map((f) => String(f.id));
  const inited = aheadInit === true;
  const fresh = inited ? ahead.filter((f) => !seen.has(String(f.id))) : [];
  const dropped = [...seen].some((id) => !aheadIds.includes(id));
  const changed = !inited || fresh.length > 0 || dropped;
  return { aheadIds, fresh, changed, inited };
}
