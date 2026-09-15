// FSRS-5 scheduler (replaces the old SM-2). Each card carries a stability S
// (days until recall drops to ~90%) and a difficulty D in 1..10; reviews are
// timed to hit a target retention. The two review buttons map to Again(1) and
// Good(3); Hard(2)/Easy(4) are here in case we ever add a 4-grade UI.

// default weights, could be tuned per-user from review logs later
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 19 / 81;            // = 0.9^(1/DECAY) - 1
const MIN_S = 0.01, MAX_S = 36500; // stability bounds (days)
const DAY = 86400000;
const AGAIN_MS = 10 * 60000;       // a lapsed card comes back in ~10 minutes
export const REQUEST_RETENTION = 0.9;

const clampD = (d) => Math.min(10, Math.max(1, d));
const clampS = (s) => Math.min(MAX_S, Math.max(MIN_S, s));

export const initStability = (g) => clampS(W[g - 1]);
export const initDifficulty = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
// recall probability t days out at stability S
export const retrievability = (t, S) => Math.pow(1 + FACTOR * (Math.max(0, t) / Math.max(MIN_S, S)), DECAY);
// whole-day interval (>=1) that lands on the target retention
export const intervalFor = (S, rr = REQUEST_RETENTION) => Math.max(1, Math.round((clampS(S) / FACTOR) * (Math.pow(rr, 1 / DECAY) - 1)));

function nextDifficulty(D, g) {
  const damped = D + (-W[6] * (g - 3)) * (10 - D) / 9;          // linear damping
  return clampD(W[7] * initDifficulty(4) + (1 - W[7]) * damped); // mean-revert toward "easy"
}
function recallStability(D, S, R, g) {
  const hard = g === 2 ? W[15] : 1, easy = g === 4 ? W[16] : 1;
  return clampS(S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * hard * easy));
}
function forgetStability(D, S, R) {
  const s = W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R));
  return clampS(Math.min(s, S)); // a lapse never increases stability
}

// Fields to merge into a card after a review. Handles a fresh card and a legacy
// SM-2 card (interval but no stability -> seed stability off the interval so we
// don't wipe existing progress).
export function reviewCard(card, grade, now = Date.now()) {
  const g = grade === 1 ? 1 : grade === 2 ? 2 : grade === 4 ? 4 : 3;
  const hasFsrs = typeof card?.stability === "number" && card.stability > 0;
  const isNew = !hasFsrs && !(Number(card?.reps) > 0) && !(Number(card?.interval) > 0);
  let S, D;
  if (isNew) {
    S = initStability(g); D = initDifficulty(g);
  } else {
    const S0 = hasFsrs ? card.stability : Math.max(1, Number(card.interval) || 1);
    const D0 = typeof card?.difficulty === "number" && card.difficulty > 0 ? card.difficulty : 5;
    const last = Number(card?.lastReview) || (Number(card?.due) - (Number(card?.interval) || 0) * DAY) || now;
    const elapsed = Math.max(0, (now - last) / DAY);
    const R = retrievability(elapsed, S0);
    D = nextDifficulty(D0, g);
    S = g === 1 ? forgetStability(D, S0, R) : recallStability(D, S0, R, g);
  }
  const common = {
    stability: Math.round(S * 1000) / 1000,
    difficulty: Math.round(D * 100) / 100,
    lastReview: now,
    lapses: (Number(card?.lapses) || 0) + (g === 1 ? 1 : 0),
  };
  if (g === 1) {
    // lapse: show it again this session, the S/D above carry to the next pass
    return { ...common, interval: 0, reps: 0, due: now + AGAIN_MS, state: "relearning" };
  }
  const interval = intervalFor(S);
  return { ...common, interval, reps: (Number(card?.reps) || 0) + 1, due: now + interval * DAY, state: "review" };
}

// next interval in whole days for a grade, without touching the card
export function previewInterval(card, grade, now = Date.now()) {
  return reviewCard(card, grade, now).interval;
}
