import {
  CATEGORIES, COLUMN_IDS, activePlayerIndex, allowedRange, analyzeRoll,
  appendTimelineEvent, categoryById, columnSummary, emptyPlayer, isCellPlayable,
  isGameComplete, materializePlayers, playerSummary, redoTimeline, sacrificeEntry,
  scoreEntry, scoreOptions, undoTimeline, validateScore,
} from "./scoring.js";
import {
  archiveActiveGame, loadAppData, requestPersistentStorage, saveAppData,
  sortProfilesByRecentUse, updateRememberedProfiles,
} from "./storage.js";
import { buildStatistics, completedGameRecord, newRecordBadges } from "./statistics.js";

const app = document.querySelector("#app");
const COLUMN_LABELS = { order: "Ordre", disorder: "Désordre" };
const DICE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

let data;
const ui = {
  screen: "home",
  returnScreen: "home",
  playerCount: 4,
  setupPlayers: [],
  modal: null,
  dice: [1, 1, 1, 1, 1],
  completed: null,
  error: "",
};

function id(prefix) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(value));
}

async function persist() {
  data = await saveAppData(data);
}

async function init() {
  try {
    data = await loadAppData();
    render();
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    app.innerHTML = `<main class="fatal-card"><p class="eyebrow">ERREUR DE STOCKAGE</p><h1>Impossible d’ouvrir la table</h1><p>${escapeHtml(error.message)}</p><button class="button primary" onclick="location.reload()">Réessayer</button></main>`;
  }
}

function shell(content, options = {}) {
  const { back = false, compact = false } = options;
  return `<div class="app-shell ${compact ? "compact" : ""}">
    <header class="topbar">
      <div class="topbar-left">${back ? '<button class="icon-button" data-action="back" aria-label="Retour">←</button>' : ""}<button class="brand" data-action="home" aria-label="Accueil"><span class="mini-die">⚄</span><span>Yam’s</span></button></div>
      <button class="icon-button" data-action="rules" aria-label="Règles du jeu" title="Règles">?</button>
    </header>
    ${content}
    ${renderModal()}
  </div>`;
}

function render() {
  if (ui.screen === "home") app.innerHTML = shell(renderHome(), { compact: true });
  else if (ui.screen === "setup-count") app.innerHTML = shell(renderCountSetup(), { back: true, compact: true });
  else if (ui.screen === "setup-players") app.innerHTML = shell(renderPlayersSetup(), { back: true, compact: true });
  else if (ui.screen === "game") app.innerHTML = renderGame();
  else if (ui.screen === "rules") app.innerHTML = shell(renderRules(), { back: true });
  else if (ui.screen === "stats") app.innerHTML = shell(renderStatistics(), { back: true });
  else if (ui.screen === "results") app.innerHTML = shell(renderResults());
  afterRender();
}

function afterRender() {
  if (ui.screen === "game") {
    requestAnimationFrame(() => document.querySelector(".active-player-head")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }));
  }
  if (ui.modal?.type === "score") requestAnimationFrame(() => document.querySelector("#variable-score")?.focus());
}

function renderHome() {
  return `<main class="home-screen">
    <section class="hero-card">
      <div class="brand-die hero-die" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <p class="eyebrow">LA TABLE FAMILIALE</p>
      <h1>Yam’s</h1>
      <p class="lead">Deux colonnes, cinq dés et juste ce qu’il faut de mauvaise foi.</p>
      <div class="home-actions">
        ${data.activeGame ? '<button class="button primary large" data-action="resume">Reprendre la partie</button>' : ""}
        <button class="button ${data.activeGame ? "secondary" : "primary"} large" data-action="new-game">Nouvelle partie</button>
        <div class="action-pair">
          <button class="button quiet" data-action="rules">Règles du jeu</button>
          <button class="button quiet" data-action="stats">Statistiques</button>
        </div>
      </div>
      ${data.activeGame ? `<p class="saved-note">Sauvegardée · ${data.activeGame.basePlayers.length} joueurs · ${data.activeGame.timeline.cursor} scores saisis</p>` : '<p class="saved-note">Fonctionne hors ligne sur cet appareil</p>'}
    </section>
  </main>`;
}

function renderCountSetup() {
  return `<main class="centered-page setup-page">
    <section class="panel narrow">
      <p class="eyebrow">NOUVELLE PARTIE · 1/2</p>
      <h1>Combien de joueurs&nbsp;?</h1>
      <p class="lead">Choisissez l’effectif autour de la table.</p>
      <div class="count-picker" role="group" aria-label="Nombre de joueurs">
        ${Array.from({ length: 12 }, (_, index) => index + 1).map((count) => `<button class="count-button ${ui.playerCount === count ? "selected" : ""}" data-action="set-count" data-count="${count}">${count}</button>`).join("")}
      </div>
      <button class="button primary large full" data-action="continue-setup">Continuer avec ${ui.playerCount} joueur${ui.playerCount > 1 ? "s" : ""}</button>
    </section>
  </main>`;
}

function setupPlayerRow(player, index, profiles) {
  return `<fieldset class="player-setup-card">
    <legend><span>${index + 1}</span> Joueur ${index + 1}</legend>
    <label>Joueur enregistré
      <select data-setup-profile="${index}">
        <option value="">Nouveau nom</option>
        ${profiles.map((profile) => `<option value="${profile.id}" ${player.profileId === profile.id ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}
      </select>
    </label>
    <label>Nom
      <input data-setup-name="${index}" maxlength="24" value="${escapeHtml(player.name)}" placeholder="Prénom ou surnom" ${player.profileId ? "readonly" : ""} />
    </label>
    ${player.profileId ? '<p class="profile-note">Profil mémorisé · ses statistiques seront regroupées.</p>' : `<label class="check-label"><input type="checkbox" data-setup-remember="${index}" ${player.remember ? "checked" : ""}/> Mémoriser ce joueur</label>`}
  </fieldset>`;
}

function renderPlayersSetup() {
  const profiles = sortProfilesByRecentUse(data.profiles);
  return `<main class="centered-page setup-page wide">
    <section class="panel">
      <p class="eyebrow">NOUVELLE PARTIE · 2/2</p>
      <h1>Ordre de jeu</h1>
      <p class="lead">Les joueurs joueront dans cet ordre pendant toute la partie.</p>
      <form id="players-form">
        <div class="players-setup-grid">${ui.setupPlayers.map((player, index) => setupPlayerRow(player, index, profiles)).join("")}</div>
        ${ui.error ? `<p class="form-error" role="alert">${escapeHtml(ui.error)}</p>` : ""}
        <button class="button primary large full" type="submit">Commencer la partie</button>
      </form>
    </section>
  </main>`;
}

function materializedGame() {
  const game = data.activeGame;
  return { game, players: materializePlayers(game.basePlayers, game.timeline) };
}

function entryMarkup(entry, playable) {
  if (entry?.kind === "score") return `<span class="score-value">${entry.score}</span>`;
  if (entry?.kind === "sacrifice") return '<span class="sacrifice-mark" aria-label="Sacrifiée">╱</span>';
  return playable ? '<span class="playable-dot">＋</span>' : '<span class="empty-mark">·</span>';
}

function scoreCell(player, playerIndex, columnId, category, activeIndex) {
  const entry = player.columns[columnId][category.id];
  const active = playerIndex === activeIndex;
  const playable = active && isCellPlayable(player, columnId, category.id);
  const classes = ["player-cell", active ? "active-player" : "", playable ? "is-playable" : "", entry?.kind === "sacrifice" ? "is-sacrificed" : "", entry?.kind === "score" ? "is-scored" : ""].filter(Boolean).join(" ");
  return `<td class="${classes}"><button class="score-cell" ${playable ? `data-action="open-score" data-player="${playerIndex}" data-column="${columnId}" data-category="${category.id}"` : "disabled"} aria-label="${escapeHtml(player.name)}, ${COLUMN_LABELS[columnId]}, ${category.label}">${entryMarkup(entry, playable)}</button></td>`;
}

function computedCell(player, columnId, kind, active) {
  const summary = columnSummary(player.columns[columnId]);
  let content = "";
  let extra = "";
  if (kind === "upper") {
    content = summary.upper.complete ? summary.upper.subtotal : `${summary.upper.trend >= 0 ? "+" : ""}${summary.upper.trend}`;
    extra = summary.upper.complete ? "" : "trend";
  } else if (kind === "bonus") {
    if (summary.upper.bonus.status === "earned") content = "30";
    else if (summary.upper.bonus.status === "lost") { content = "╱"; extra = "is-sacrificed"; }
    else content = "";
  } else if (kind === "total") content = summary.total ?? "";
  return `<td class="computed-cell player-cell ${active ? "active-player" : ""} ${extra}">${content}</td>`;
}

function renderGameTable(players, activeIndex) {
  const head = players.map((player, index) => `<th class="player-head ${index === activeIndex ? "active-player-head" : ""}" colspan="2"><span>${escapeHtml(player.name)}</span><small>${index === activeIndex ? "À son tour" : `Joueur ${index + 1}`}</small></th>`).join("");
  const subhead = players.map((_, index) => `<th class="column-head player-cell ${index === activeIndex ? "active-player" : ""}">O</th><th class="column-head player-cell ${index === activeIndex ? "active-player" : ""}">D</th>`).join("");
  const rows = CATEGORIES.map((category, categoryIndex) => {
    const divider = categoryIndex === 6 ? " section-start" : "";
    return `<tr class="category-row${divider}"><th scope="row"><button class="category-label" data-action="category-rule" data-category="${category.id}"><span>${category.label}</span>${category.fixed ? `<small>${category.fixed} pts</small>` : ""}</button></th>${players.map((player, playerIndex) => COLUMN_IDS.map((columnId) => scoreCell(player, playerIndex, columnId, category, activeIndex)).join("")).join("")}</tr>`;
  }).join("");
  const computed = (label, kind, className = "") => `<tr class="computed-row ${className}"><th scope="row">${label}</th>${players.map((player, index) => COLUMN_IDS.map((columnId) => computedCell(player, columnId, kind, index === activeIndex)).join("")).join("")}</tr>`;
  const general = `<tr class="computed-row general-row"><th scope="row">Total général</th>${players.map((_, index) => `<td colspan="2" class="player-cell ${index === activeIndex ? "active-player" : ""}"><span class="hidden-total">À révéler</span></td>`).join("")}</tr>`;
  return `<div class="score-table-wrap"><table class="score-table"><thead><tr><th rowspan="2" class="category-corner">Catégorie</th>${head}</tr><tr>${subhead}</tr></thead><tbody>${rows.slice(0, rows.indexOf('<tr class="category-row section-start'))}${computed("Total intermédiaire", "upper", "upper-total")}${computed("Bonus ≥ 63", "bonus", "bonus-row")}${rows.slice(rows.indexOf('<tr class="category-row section-start'))}${computed("Total de colonne", "total", "column-total")}${general}</tbody></table></div>`;
}

function renderGame() {
  const { game, players } = materializedGame();
  const activeIndex = activePlayerIndex(players.length, game.timeline.cursor);
  const active = players[activeIndex];
  return `<div class="game-shell">
    <header class="game-toolbar">
      <button class="brand" data-action="quit-game"><span class="mini-die">⚄</span><span>Yam’s</span></button>
      <div class="turn-identity"><small>AU TOUR DE</small><strong>${escapeHtml(active.name)}</strong><span>${game.timeline.cursor + 1}e saisie</span></div>
      <div class="game-actions">
        <button class="toolbar-button" data-action="roll-helper"><b class="toolbar-symbol">Dés</b><span>Analyser</span></button>
        <button class="toolbar-button" data-action="undo" ${game.timeline.cursor === 0 ? "disabled" : ""}>↶ <span>Annuler</span></button>
        <button class="toolbar-button" data-action="redo" ${game.timeline.cursor === game.timeline.events.length ? "disabled" : ""}>↷ <span>Rétablir</span></button>
        <button class="toolbar-button" data-action="rules">? <span>Règles</span></button>
        <button class="toolbar-button" data-action="quit-game">⌂ <span>Quitter</span></button>
      </div>
    </header>
    <main class="game-main">
      <div class="turn-mobile"><small>AU TOUR DE</small><strong>${escapeHtml(active.name)}</strong></div>
      ${renderGameTable(players, activeIndex)}
      <p class="game-hint">Touchez une case mise en évidence pour inscrire le résultat. Les scores sont sauvegardés automatiquement.</p>
    </main>
    ${renderModal()}
  </div>`;
}

function rulesBody() {
  return `<section class="rules-intro"><h2>Déroulement</h2><p>À son tour, chaque joueur choisit la prochaine case de sa colonne Ordre ou une case libre de sa colonne Désordre. Une case peut recevoir un score valide ou être sacrifiée.</p></section>
    <section class="rules-grid">${CATEGORIES.map((category) => `<article class="rule-card"><div><h3>${category.label}</h3>${category.fixed ? `<span>${category.fixed} points</span>` : ""}</div><p>${category.help}</p></article>`).join("")}</section>
    <section class="rules-intro"><h2>Bonus et totaux</h2><p>Le bonus de 30 points est acquis à partir de 63 dans les lignes 1 à 6. Avant leur achèvement, la case indique l’avance ou le retard sur une moyenne de trois dés par ligne. Le total général additionne les totaux Ordre et Désordre.</p></section>`;
}

function renderRules() {
  return `<main class="content-page"><p class="eyebrow">RÉFÉRENCE</p><h1>Règles du jeu</h1><p class="lead">La variante familiale, sans zones grises ni arbitrage vidéo.</p>${rulesBody()}</main>`;
}

function recordCard(label, record, key) {
  return `<article class="record-card"><span>${label}</span>${record ? `<strong>${record[key]}</strong><p>${escapeHtml(record.name)} · ${formatDate(record.date)}</p>` : '<strong>—</strong><p>Aucune partie terminée</p>'}</article>`;
}

function renderStatistics() {
  const stats = buildStatistics(data.pastGames, data.profiles, data.activeGame);
  return `<main class="content-page stats-page"><p class="eyebrow">ARCHIVES LOCALES</p><h1>Statistiques</h1>
    <section class="stat-counts"><article><strong>${stats.counts.started}</strong><span>commencée${stats.counts.started > 1 ? "s" : ""}</span></article><article><strong>${stats.counts.completed}</strong><span>terminée${stats.counts.completed > 1 ? "s" : ""}</span></article><article><strong>${stats.counts.abandoned}</strong><span>abandonnée${stats.counts.abandoned > 1 ? "s" : ""}</span></article></section>
    <h2>Records</h2><section class="records-grid">${recordCard("Plus haut total", stats.records.highestGeneral, "general")}${recordCard("Plus haut Ordre", stats.records.highestOrder, "order")}${recordCard("Plus haut Désordre", stats.records.highestDisorder, "disorder")}${recordCard("Plus petit total", stats.records.lowestGeneral, "general")}</section>
    <h2>Top 10</h2><section class="ranking-list">${stats.topTen.length ? stats.topTen.map((entry, index) => `<article><span class="rank">${index + 1}</span><div><strong>${escapeHtml(entry.name)}</strong><small>${formatDate(entry.date)}</small></div><b>${entry.general}</b></article>`).join("") : '<p class="empty-state">Les records apparaîtront après la première partie terminée.</p>'}</section>
    <h2>Joueurs enregistrés</h2><section class="ranking-list">${stats.playerRanking.length ? stats.playerRanking.map((entry, index) => `<article><span class="rank">${index + 1}</span><div><strong>${escapeHtml(entry.profile.name)}</strong><small>${entry.games} partie${entry.games > 1 ? "s" : ""} · ${entry.wins} victoire${entry.wins > 1 ? "s" : ""}</small></div><b>${entry.best}</b></article>`).join("") : '<p class="empty-state">Aucun joueur enregistré n’a encore terminé de partie.</p>'}</section>
  </main>`;
}

function renderResults() {
  const completed = ui.completed;
  if (!completed) return '<main class="content-page"><h1>Aucun résultat à afficher</h1></main>';
  return `<main class="results-page"><p class="eyebrow">PARTIE TERMINÉE</p><h1>Classement final</h1><p class="lead">Les totaux sont tombés. Les excuses peuvent commencer.</p>
    <section class="final-ranking">${completed.record.results.map((result, index) => {
      const badges = completed.badges.filter((badge) => badge.playerId === result.playerId);
      return `<article class="final-result rank-${result.rank}" style="--delay:${index * 90}ms"><span class="podium-rank">${result.rank}</span><div class="result-player"><strong>${escapeHtml(result.name)}</strong><small>Ordre ${result.order} · Désordre ${result.disorder}</small>${badges.map((badge) => `<em>✦ ${badge.label}</em>`).join("")}</div><b>${result.general}</b></article>`;
    }).join("")}</section>
    <div class="results-actions"><button class="button primary large" data-action="home">Retour à l’accueil</button><button class="button secondary large" data-action="stats">Voir les statistiques</button><button class="button quiet large full-span" data-action="correct-last">↶ Corriger la dernière saisie</button></div>
  </main>`;
}

function scoreModal(modal) {
  const { players } = materializedGame();
  const player = players[modal.playerIndex];
  const category = categoryById(modal.categoryId);
  const cells = player.columns[modal.columnId];
  const options = scoreOptions(category.id, cells);
  const range = allowedRange(category.id, cells);
  let input = "";
  if (category.kind === "upper") input = `<div class="score-choice-grid">${options.map((score) => `<button class="score-choice" data-action="commit-score" data-score="${score}">${score}</button>`).join("")}</div>`;
  else if (category.kind === "fixed") input = `<button class="button success large full" data-action="commit-score" data-score="${category.fixed}">Valider · ${category.fixed} points</button>`;
  else if (options.length === 0) input = '<p class="constraint-warning">L’autre valeur rend tout score valide impossible. Cette case doit être sacrifiée.</p>';
  else input = `<form id="variable-score-form"><label class="numeric-label">Score entre ${range.min} et ${range.max}<input id="variable-score" name="score" type="number" inputmode="numeric" min="${range.min}" max="${range.max}" required /></label><button class="button success large" type="submit">Valider</button></form>`;
  return dialogFrame(`<p class="eyebrow">${escapeHtml(player.name)} · ${COLUMN_LABELS[modal.columnId]}</p><h2>${category.label}</h2><p class="dialog-help">${category.help}</p>${input}<button class="button danger-outline full" data-action="sacrifice">╱ Sacrifier cette case</button>`, "Saisie du score");
}

function rollHelperModal() {
  const { game, players } = materializedGame();
  const active = players[activePlayerIndex(players.length, game.timeline.cursor)];
  const suggestions = analyzeRoll(active, ui.dice);
  return dialogFrame(`<p class="eyebrow">AIDE AU CHOIX · ${escapeHtml(active.name)}</p><h2>Analyser les dés</h2><p class="dialog-help">Touchez chaque dé pour changer sa valeur. Cette aide ne modifie pas la partie.</p>
    <div class="dice-row">${ui.dice.map((die, index) => `<button class="die-button" data-action="cycle-die" data-die="${index}" aria-label="Dé ${index + 1}, valeur ${die}">${DICE_GLYPHS[die - 1]}</button>`).join("")}</div>
    <div class="suggestions">${suggestions.length ? suggestions.map((item) => { const category = categoryById(item.categoryId); const warning = (item.categoryId === "minus" && item.score === 30) || (item.categoryId === "plus" && item.score === 19); return `<article><div><strong>${category.label}</strong><small>${COLUMN_LABELS[item.columnId]}${warning ? " · condamne l’autre case" : ""}</small></div><b>${item.score}</b></article>`; }).join("") : '<p class="no-suggestion">Aucune case jouable ne donne de score positif : ce tirage impose un sacrifice.</p>'}</div>`, "Analyse du tirage");
}

function dialogFrame(content, label) {
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true" aria-label="${label}" data-modal-card><button class="modal-close" data-action="close-modal" aria-label="Fermer">×</button>${content}</section></div>`;
}

function renderModal() {
  if (!ui.modal) return "";
  if (ui.modal.type === "score") return scoreModal(ui.modal);
  if (ui.modal.type === "roll") return rollHelperModal();
  if (ui.modal.type === "abandon") return dialogFrame('<p class="eyebrow">PARTIE EN COURS</p><h2>Abandonner la partie ?</h2><p class="dialog-help">Elle sera archivée comme abandonnée et ne pourra plus être reprise.</p><div class="dialog-actions"><button class="button quiet" data-action="close-modal">Conserver la partie</button><button class="button danger" data-action="confirm-abandon">Abandonner et continuer</button></div>', "Confirmation d’abandon");
  if (ui.modal.type === "category") {
    const category = categoryById(ui.modal.categoryId);
    return dialogFrame(`<p class="eyebrow">RÈGLE</p><h2>${category.label}</h2><p class="dialog-help rule-detail">${category.help}</p>${category.fixed ? `<p class="fixed-score-callout">${category.fixed} points</p>` : ""}`, category.label);
  }
  return "";
}

function beginSetup() {
  ui.playerCount = 4;
  ui.screen = "setup-count";
  ui.modal = null;
  ui.error = "";
  render();
}

async function startGame() {
  const names = ui.setupPlayers.map((player) => player.name.trim());
  if (names.some((name) => !name)) {
    ui.error = "Chaque joueur doit avoir un nom.";
    render();
    return;
  }
  const usedAt = new Date().toISOString();
  const basePlayers = ui.setupPlayers.map((player) => ({ id: id("player"), name: player.name.trim(), profileId: player.profileId || (player.remember ? player.id : null) }));
  data.profiles = updateRememberedProfiles(data.profiles, ui.setupPlayers, usedAt);
  data.activeGame = { id: id("game"), status: "active", createdAt: usedAt, basePlayers, timeline: { events: [], cursor: 0 } };
  await persist();
  requestPersistentStorage();
  ui.screen = "game";
  render();
}

async function commitEntry(entry) {
  const modal = ui.modal;
  if (!modal || modal.type !== "score") return;
  const { game, players } = materializedGame();
  const activeIndex = activePlayerIndex(players.length, game.timeline.cursor);
  const player = players[activeIndex];
  if (modal.playerIndex !== activeIndex || !isCellPlayable(player, modal.columnId, modal.categoryId)) return;
  if (entry.kind === "score" && !validateScore(modal.categoryId, entry.score, player.columns[modal.columnId])) return;

  const previousStats = buildStatistics(data.pastGames, data.profiles);
  game.timeline = appendTimelineEvent(game.timeline, {
    id: id("event"), playerId: player.id, columnId: modal.columnId,
    categoryId: modal.categoryId, entry, createdAt: new Date().toISOString(),
  });
  data.activeGame = game;
  ui.modal = null;
  const updatedPlayers = materializePlayers(game.basePlayers, game.timeline);
  if (isGameComplete(updatedPlayers)) {
    const record = completedGameRecord(game, updatedPlayers, new Date().toISOString());
    const badges = newRecordBadges(previousStats, record.results);
    data.pastGames.push(record);
    data.activeGame = null;
    ui.completed = { record, badges };
    ui.screen = "results";
  }
  await persist();
  render();
}

async function moveHistory(direction) {
  if (!data.activeGame) return;
  data.activeGame.timeline = direction === "undo" ? undoTimeline(data.activeGame.timeline) : redoTimeline(data.activeGame.timeline);
  await persist();
  render();
}

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.closest("[data-modal-card]") && button.dataset.action === undefined) return;
  const action = button.dataset.action;
  if (action === "home") { ui.screen = "home"; ui.modal = null; render(); }
  else if (action === "back") { ui.screen = ui.screen === "setup-players" ? "setup-count" : ui.returnScreen; render(); }
  else if (action === "resume") { ui.screen = "game"; render(); }
  else if (action === "new-game") { data.activeGame ? (ui.modal = { type: "abandon" }, render()) : beginSetup(); }
  else if (action === "confirm-abandon") { data = archiveActiveGame(data, "abandoned", new Date().toISOString()); await persist(); beginSetup(); }
  else if (action === "set-count") { ui.playerCount = Number(button.dataset.count); render(); }
  else if (action === "continue-setup") { ui.setupPlayers = Array.from({ length: ui.playerCount }, () => ({ id: id("profile"), profileId: null, name: "", remember: false })); ui.screen = "setup-players"; render(); }
  else if (action === "rules") { ui.returnScreen = ui.screen; ui.screen = "rules"; ui.modal = null; render(); }
  else if (action === "stats") { ui.returnScreen = ui.screen === "results" ? "home" : ui.screen; ui.screen = "stats"; ui.modal = null; render(); }
  else if (action === "correct-last" && ui.completed) {
    const record = ui.completed.record;
    data.pastGames = data.pastGames.filter((game) => game.id !== record.id);
    data.activeGame = { ...record, status: "active", endedAt: undefined, results: undefined, timeline: undoTimeline(record.timeline) };
    ui.completed = null;
    ui.screen = "game";
    await persist();
    render();
  }
  else if (action === "quit-game") { ui.screen = "home"; ui.modal = null; render(); }
  else if (action === "undo" || action === "redo") await moveHistory(action);
  else if (action === "open-score") { ui.modal = { type: "score", playerIndex: Number(button.dataset.player), columnId: button.dataset.column, categoryId: button.dataset.category }; render(); }
  else if (action === "commit-score") await commitEntry(scoreEntry(Number(button.dataset.score)));
  else if (action === "sacrifice") await commitEntry(sacrificeEntry());
  else if (action === "close-modal") { if (event.target === button || button.classList.contains("modal-close") || button.tagName === "BUTTON") { ui.modal = null; render(); } }
  else if (action === "category-rule") { ui.modal = { type: "category", categoryId: button.dataset.category }; render(); }
  else if (action === "roll-helper") { ui.dice = [1, 1, 1, 1, 1]; ui.modal = { type: "roll" }; render(); }
  else if (action === "cycle-die") { const index = Number(button.dataset.die); ui.dice[index] = (ui.dice[index] % 6) + 1; render(); }
});

app.addEventListener("change", (event) => {
  const profileIndex = event.target.dataset.setupProfile;
  const rememberIndex = event.target.dataset.setupRemember;
  if (profileIndex !== undefined) {
    const index = Number(profileIndex);
    const profile = data.profiles.find((item) => item.id === event.target.value);
    ui.setupPlayers[index].profileId = profile?.id ?? null;
    ui.setupPlayers[index].name = profile?.name ?? "";
    ui.setupPlayers[index].remember = false;
    render();
  } else if (rememberIndex !== undefined) {
    ui.setupPlayers[Number(rememberIndex)].remember = event.target.checked;
  }
});

app.addEventListener("input", (event) => {
  const index = event.target.dataset.setupName;
  if (index !== undefined) ui.setupPlayers[Number(index)].name = event.target.value;
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "players-form") await startGame();
  if (event.target.id === "variable-score-form") await commitEntry(scoreEntry(Number(new FormData(event.target).get("score") ?? document.querySelector("#variable-score")?.value)));
});

init();
