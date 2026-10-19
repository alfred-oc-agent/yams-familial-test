import { finalRanking } from "./scoring.js";

export function completedGameRecord(game, players, endedAt) {
  const ranking = finalRanking(players);
  let previousScore = null;
  let previousRank = 0;
  const results = ranking.map((player, index) => {
    const rank = player.summary.general === previousScore ? previousRank : index + 1;
    previousScore = player.summary.general;
    previousRank = rank;
    return {
      playerId: player.id,
      profileId: player.profileId,
      name: player.name,
      rank,
      order: player.summary.order.total,
      disorder: player.summary.disorder.total,
      general: player.summary.general,
    };
  });
  return { ...structuredClone(game), status: "completed", endedAt, results };
}

function extreme(records, key, direction) {
  if (records.length === 0) return null;
  return [...records].sort((a, b) => direction * (a[key] - b[key]))[0];
}

export function buildStatistics(pastGames, profiles, activeGame = null) {
  const completed = pastGames.filter((game) => game.status === "completed");
  const abandoned = pastGames.filter((game) => game.status === "abandoned");
  const results = completed.flatMap((game) => game.results.map((result) => ({ ...result, gameId: game.id, date: game.endedAt })));
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const profileStats = new Map();

  for (const result of results) {
    if (!result.profileId || !profileMap.has(result.profileId)) continue;
    const current = profileStats.get(result.profileId) ?? { profile: profileMap.get(result.profileId), games: 0, wins: 0, best: null };
    current.games += 1;
    if (result.rank === 1) current.wins += 1;
    current.best = current.best === null ? result.general : Math.max(current.best, result.general);
    profileStats.set(result.profileId, current);
  }

  return {
    counts: {
      started: pastGames.length + (activeGame ? 1 : 0),
      completed: completed.length,
      abandoned: abandoned.length,
    },
    records: {
      highestGeneral: extreme(results, "general", -1),
      lowestGeneral: extreme(results, "general", 1),
      highestOrder: extreme(results, "order", -1),
      lowestOrder: extreme(results, "order", 1),
      highestDisorder: extreme(results, "disorder", -1),
      lowestDisorder: extreme(results, "disorder", 1),
    },
    topTen: [...results].sort((a, b) => b.general - a.general).slice(0, 10),
    playerRanking: [...profileStats.values()].sort((a, b) => b.games - a.games || b.wins - a.wins || b.best - a.best),
  };
}

export function newRecordBadges(previousStats, results) {
  const previous = previousStats.records;
  const definitions = [
    { type: "general", record: previous.highestGeneral },
    { type: "order", record: previous.highestOrder },
    { type: "disorder", record: previous.highestDisorder },
  ];
  return definitions.flatMap(({ type, record }) => {
    const newMaximum = Math.max(...results.map((result) => result[type]));
    const previousMaximum = record?.[type] ?? -Infinity;
    if (newMaximum <= previousMaximum) return [];
    return results
      .filter((result) => result[type] === newMaximum)
      .map((result) => ({ playerId: result.playerId, type }));
  });
}
