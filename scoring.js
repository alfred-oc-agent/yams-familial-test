export const COLUMN_IDS = ["order", "disorder"];

export const CATEGORIES = [
  { id: "ones", label: "Un", kind: "upper", face: 1, help: "Additionnez tous les dés affichant 1." },
  { id: "twos", label: "Deux", kind: "upper", face: 2, help: "Additionnez tous les dés affichant 2." },
  { id: "threes", label: "Trois", kind: "upper", face: 3, help: "Additionnez tous les dés affichant 3." },
  { id: "fours", label: "Quatre", kind: "upper", face: 4, help: "Additionnez tous les dés affichant 4." },
  { id: "fives", label: "Cinq", kind: "upper", face: 5, help: "Additionnez tous les dés affichant 5." },
  { id: "sixes", label: "Six", kind: "upper", face: 6, help: "Additionnez tous les dés affichant 6." },
  { id: "threeKind", label: "Brelan", kind: "variable", min: 5, max: 30, help: "Au moins trois dés identiques. Score : somme des cinq dés." },
  { id: "fourKind", label: "Carré", kind: "variable", min: 5, max: 30, help: "Au moins quatre dés identiques. Score : somme des cinq dés." },
  { id: "smallStraight", label: "Petite suite", kind: "fixed", fixed: 20, help: "Quatre valeurs consécutives, avec un cinquième dé quelconque." },
  { id: "largeStraight", label: "Grande suite", kind: "fixed", fixed: 30, help: "1-2-3-4-5 ou 2-3-4-5-6." },
  { id: "fullHouse", label: "Full", kind: "fixed", fixed: 40, help: "Un brelan et une paire de valeurs différentes." },
  { id: "fourAces", label: "Carré d’as", kind: "fixed", fixed: 50, help: "Au moins quatre dés affichant 1." },
  { id: "underEight", label: "Moins de 8", kind: "fixed", fixed: 60, help: "La somme des cinq dés est strictement inférieure à 8." },
  { id: "yams", label: "Yam’s", kind: "fixed", fixed: 80, help: "Cinq dés identiques." },
  { id: "minus", label: "Moins", kind: "variable", min: 19, max: 30, help: "Somme des cinq dés, inférieure au score Plus." },
  { id: "plus", label: "Plus", kind: "variable", min: 19, max: 30, help: "Somme des cinq dés, supérieure au score Moins." },
];

export const UPPER_CATEGORIES = CATEGORIES.filter((category) => category.kind === "upper");
export const LOWER_CATEGORIES = CATEGORIES.filter((category) => category.kind !== "upper");

export function categoryById(categoryId) {
  return CATEGORIES.find((category) => category.id === categoryId) ?? null;
}

export function emptyColumn() {
  return Object.fromEntries(CATEGORIES.map((category) => [category.id, null]));
}

export function emptyPlayer({ id, name, profileId = null }) {
  return { id, name, profileId, columns: { order: emptyColumn(), disorder: emptyColumn() } };
}

export function isResolved(entry) {
  return entry?.kind === "score" || entry?.kind === "sacrifice";
}

export function numericValue(entry) {
  return entry?.kind === "score" ? entry.score : 0;
}

export function scoreEntry(score) {
  return { kind: "score", score };
}

export function sacrificeEntry() {
  return { kind: "sacrifice" };
}

export function scoreOptions(categoryId, cells = emptyColumn()) {
  const category = categoryById(categoryId);
  if (!category) return [];
  if (category.kind === "upper") return Array.from({ length: 5 }, (_, index) => (index + 1) * category.face);
  if (category.kind === "fixed") return [category.fixed];
  const { min, max } = allowedRange(categoryId, cells);
  if (min > max) return [];
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

export function allowedRange(categoryId, cells = emptyColumn()) {
  const category = categoryById(categoryId);
  if (!category || category.kind !== "variable") return { min: 1, max: 0 };
  let { min, max } = category;
  if (categoryId === "minus" && cells.plus?.kind === "score") max = Math.min(max, cells.plus.score - 1);
  if (categoryId === "plus" && cells.minus?.kind === "score") min = Math.max(min, cells.minus.score + 1);
  return { min, max };
}

export function validateScore(categoryId, score, cells = emptyColumn()) {
  if (!Number.isInteger(score)) return false;
  const category = categoryById(categoryId);
  if (!category) return false;
  if (category.kind === "upper") return scoreOptions(categoryId, cells).includes(score);
  if (category.kind === "fixed") return score === category.fixed;
  const { min, max } = allowedRange(categoryId, cells);
  return score >= min && score <= max;
}

export function nextOrderCategory(cells) {
  return CATEGORIES.find((category) => !isResolved(cells[category.id]))?.id ?? null;
}

export function isCellPlayable(player, columnId, categoryId) {
  if (!COLUMN_IDS.includes(columnId) || !categoryById(categoryId)) return false;
  const cells = player.columns[columnId];
  if (isResolved(cells[categoryId])) return false;
  return columnId === "disorder" || nextOrderCategory(cells) === categoryId;
}

export function playableCells(player) {
  const result = [];
  const orderCategory = nextOrderCategory(player.columns.order);
  if (orderCategory) result.push({ columnId: "order", categoryId: orderCategory });
  for (const category of CATEGORIES) {
    if (!isResolved(player.columns.disorder[category.id])) result.push({ columnId: "disorder", categoryId: category.id });
  }
  return result;
}

export function upperSummary(cells) {
  let subtotal = 0;
  let trend = 0;
  let maxReachable = 0;
  let resolvedCount = 0;
  for (const category of UPPER_CATEGORIES) {
    const entry = cells[category.id];
    if (isResolved(entry)) {
      const value = numericValue(entry);
      subtotal += value;
      trend += value - (3 * category.face);
      maxReachable += value;
      resolvedCount += 1;
    } else {
      maxReachable += 5 * category.face;
    }
  }
  const complete = resolvedCount === UPPER_CATEGORIES.length;
  const bonus = subtotal >= 63
    ? { status: "earned", value: 30 }
    : maxReachable < 63
      ? { status: "lost", value: 0 }
      : { status: "pending", value: null };
  return { subtotal, trend, maxReachable, resolvedCount, complete, bonus };
}

export function columnSummary(cells) {
  const upper = upperSummary(cells);
  const complete = CATEGORIES.every((category) => isResolved(cells[category.id]));
  const lowerTotal = LOWER_CATEGORIES.reduce((sum, category) => sum + numericValue(cells[category.id]), 0);
  const total = complete ? upper.subtotal + (upper.bonus.value ?? 0) + lowerTotal : null;
  return { upper, lowerTotal, complete, total };
}

export function playerSummary(player, revealGeneral = false) {
  const order = columnSummary(player.columns.order);
  const disorder = columnSummary(player.columns.disorder);
  const complete = order.complete && disorder.complete;
  return { order, disorder, complete, general: complete && revealGeneral ? order.total + disorder.total : null };
}

export function isGameComplete(players) {
  return players.length > 0 && players.every((player) => playerSummary(player).complete);
}

export function finalRanking(players) {
  if (!isGameComplete(players)) return [];
  return players
    .map((player) => ({ ...player, summary: playerSummary(player, true) }))
    .sort((a, b) => b.summary.general - a.summary.general);
}

export function appendTimelineEvent(timeline, event) {
  const events = [...timeline.events.slice(0, timeline.cursor), event];
  return { events, cursor: events.length };
}

export function undoTimeline(timeline) {
  return { ...timeline, cursor: Math.max(0, timeline.cursor - 1) };
}

export function redoTimeline(timeline) {
  return { ...timeline, cursor: Math.min(timeline.events.length, timeline.cursor + 1) };
}

export function materializePlayers(basePlayers, timeline) {
  const players = basePlayers.map((player) => emptyPlayer(player));
  const byId = new Map(players.map((player) => [player.id, player]));
  for (const event of timeline.events.slice(0, timeline.cursor)) {
    const player = byId.get(event.playerId);
    if (player) player.columns[event.columnId][event.categoryId] = structuredClone(event.entry);
  }
  return players;
}

export function activePlayerIndex(playerCount, cursor) {
  return playerCount > 0 ? cursor % playerCount : 0;
}

function countsForRoll(dice) {
  return dice.reduce((counts, die) => {
    counts[die] = (counts[die] ?? 0) + 1;
    return counts;
  }, {});
}

function containsRun(values, length) {
  const unique = new Set(values);
  for (let start = 1; start <= 7 - length; start += 1) {
    if (Array.from({ length }, (_, index) => start + index).every((value) => unique.has(value))) return true;
  }
  return false;
}

export function scoreRollForCategory(categoryId, dice, cells = emptyColumn()) {
  if (!Array.isArray(dice) || dice.length !== 5 || dice.some((die) => !Number.isInteger(die) || die < 1 || die > 6)) return null;
  const category = categoryById(categoryId);
  if (!category) return null;
  const counts = countsForRoll(dice);
  const sum = dice.reduce((total, die) => total + die, 0);
  const multiplicities = Object.values(counts).sort((a, b) => a - b);
  if (category.kind === "upper") {
    const count = counts[category.face] ?? 0;
    return count > 0 ? count * category.face : null;
  }
  switch (categoryId) {
    case "threeKind": return Math.max(...multiplicities) >= 3 ? sum : null;
    case "fourKind": return Math.max(...multiplicities) >= 4 ? sum : null;
    case "smallStraight": return containsRun(dice, 4) ? 20 : null;
    case "largeStraight": return containsRun(dice, 5) ? 30 : null;
    case "fullHouse": return multiplicities.length === 2 && multiplicities[0] === 2 && multiplicities[1] === 3 ? 40 : null;
    case "fourAces": return (counts[1] ?? 0) >= 4 ? 50 : null;
    case "underEight": return sum < 8 ? 60 : null;
    case "yams": return Math.max(...multiplicities) === 5 ? 80 : null;
    case "minus":
    case "plus": return validateScore(categoryId, sum, cells) ? sum : null;
    default: return null;
  }
}

export function analyzeRoll(player, dice) {
  return playableCells(player)
    .map(({ columnId, categoryId }) => ({
      columnId,
      categoryId,
      score: scoreRollForCategory(categoryId, dice, player.columns[columnId]),
    }))
    .filter((candidate) => candidate.score !== null && candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.columnId.localeCompare(b.columnId));
}
