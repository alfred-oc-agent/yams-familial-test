import {
  CATEGORIES, COLUMN_IDS, activePlayerIndex, allowedRange, analyzeRoll,
  appendTimelineEvent, categoryById, columnSummary, isCellPlayable,
  isGameComplete, materializePlayers, redoTimeline, sacrificeEntry,
  scoreEntry, scoreOptions, undoTimeline, validateScore,
} from "./scoring.js";
import {
  archiveActiveGame, loadAppData, requestPersistentStorage, saveAppData,
  sortProfilesByRecentUse, updateRememberedProfiles,
} from "./storage.js";
import { buildStatistics, completedGameRecord, newRecordBadges } from "./statistics.js";
import {
  categoryText, detectLocale, localeCode, localeOptions, randomLine,
  setLocale, t, tp,
} from "./i18n.js";

const app = document.querySelector("#app");
const DICE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

let data;
let navDepth = 0;
let noticeTimer = null;
const ui = {
  screen: "home", playerCount: 4, setupPlayers: [], setupIndex: 0,
  modal: null, dice: [1, 1, 1, 1, 1], completed: null,
  error: "", tagline: "", turnNotice: null,
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
  return new Intl.DateTimeFormat(localeCode(), { dateStyle: "medium" }).format(new Date(value));
}

function columnLabel(columnId) { return t(`common.${columnId}`); }

function refreshTagline(screen = ui.screen) {
  if (["home", "rules", "results"].includes(screen)) ui.tagline = randomLine(`taglines.${screen}`);
}

async function persist() { data = await saveAppData(data); }

function historyState(extra = {}) { return { yams: true, screen: ui.screen, depth: navDepth, ...extra }; }

function navigate(screen, { replace = false } = {}) {
  ui.screen = screen;
  ui.modal = null;
  ui.error = "";
  if (["home", "rules", "results"].includes(screen)) refreshTagline(screen);
  if (replace) history.replaceState(historyState(), "");
  else {
    navDepth += 1;
    history.pushState(historyState(), "");
  }
  render();
}

function openModal(modal) {
  ui.modal = modal;
  navDepth += 1;
  history.pushState(historyState({ modal: modal.type }), "");
  render();
}

function replaceModal(modal) {
  ui.modal = modal;
  history.replaceState(historyState({ modal: modal.type }), "");
  render();
}

function closeModal() {
  if (ui.modal && navDepth > 0) history.back();
  else { ui.modal = null; render(); }
}

function clearTurnNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  ui.turnNotice = null;
}

function returnHome() {
  clearTurnNotice();
  ui.modal = null;
  if (navDepth > 0) history.go(-navDepth);
  else {
    ui.screen = "home";
    refreshTagline("home");
    history.replaceState(historyState(), "");
    render();
  }
}

async function init() {
  setLocale(detectLocale());
  try {
    data = await loadAppData();
    setLocale(data.settings.locale ?? detectLocale());
    ui.screen = "home";
    navDepth = 0;
    history.replaceState(historyState(), "");
    refreshTagline("home");
    render();
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    app.innerHTML = `<main class="fatal-card"><p class="eyebrow">${t("app.storageError")}</p><h1>${t("app.storageTitle")}</h1><p>${escapeHtml(error.message)}</p><button class="button primary" onclick="location.reload()">${t("app.retry")}</button></main>`;
  }
}

function shell(content, options = {}) {
  const { back = false, compact = false, showRules = true } = options;
  return `<div class="app-shell ${compact ? "compact" : ""}">
    <header class="topbar"><div class="topbar-left">${back ? `<button class="icon-button" data-action="back" aria-label="${t("common.back")}">←</button>` : ""}<button class="brand" data-action="home" aria-label="${t("common.home")}"><span class="mini-die">⚄</span><span>Yam’s</span></button></div>${showRules ? `<button class="icon-button" data-action="rules" aria-label="${t("home.readRules")}" title="${t("common.rules")}">?</button>` : ""}</header>
    ${content}${renderModal()}
  </div>`;
}

function render() {
  if (ui.screen === "home") app.innerHTML = shell(renderHome(), { compact: true });
  else if (ui.screen === "setup-count") app.innerHTML = shell(renderCountSetup(), { back: true, compact: true });
  else if (ui.screen === "setup-players") app.innerHTML = shell(renderPlayersSetup(), { back: true, compact: true });
  else if (ui.screen === "game") app.innerHTML = renderGame();
  else if (ui.screen === "rules") app.innerHTML = shell(renderRules(), { back: true, showRules: false });
  else if (ui.screen === "stats") app.innerHTML = shell(renderStatistics(), { back: true });
  else if (ui.screen === "results") app.innerHTML = shell(renderResults());
  afterRender();
}

function afterRender() {
  if (ui.screen === "game" && !ui.modal) requestAnimationFrame(() => document.querySelector(".active-player-head")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }));
  if (ui.modal?.type === "score") requestAnimationFrame(() => document.querySelector("#variable-score")?.focus());
}

function languagePicker() {
  return `<label class="language-picker"><span>${t("home.language")}</span><select data-language>${localeOptions().map(({ code, label }) => `<option value="${code}" ${code === localeCode() ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
}

function renderHome() {
  return `<main class="home-screen"><section class="hero-card">
    <div class="brand-die hero-die" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <p class="eyebrow">${t("home.eyebrow")}</p><h1>Yam’s</h1><p class="lead">${escapeHtml(ui.tagline)}</p>
    <div class="home-actions">${data.activeGame ? `<button class="button primary large" data-action="resume">${t("home.resume")}</button>` : ""}<button class="button ${data.activeGame ? "secondary" : "primary"} large" data-action="new-game">${t("home.newGame")}</button><div class="action-pair"><button class="button quiet" data-action="rules">${t("home.readRules")}</button><button class="button quiet" data-action="stats">${t("home.statistics")}</button></div>${languagePicker()}</div>
    ${data.activeGame ? `<p class="saved-note">${t("home.saved", { players: data.activeGame.basePlayers.length, scores: data.activeGame.timeline.cursor })}</p>` : `<p class="saved-note">${t("home.offline")}</p>`}
  </section></main>`;
}

function renderCountSetup() {
  return `<main class="centered-page setup-page"><section class="panel narrow"><p class="eyebrow">${t("setup.countStep")}</p><h1>${t("setup.howMany")}</h1><p class="lead">${t("setup.countHelp")}</p><div class="count-picker" role="group" aria-label="${t("setup.countLabel")}">${Array.from({ length: 12 }, (_, index) => index + 1).map((count) => `<button class="count-button ${ui.playerCount === count ? "selected" : ""}" data-action="set-count" data-count="${count}">${count}</button>`).join("")}</div><button class="button primary large full" data-action="continue-setup">${t("setup.continue", { count: ui.playerCount })} ${tp("setup.players", ui.playerCount)}</button></section></main>`;
}

function setupPlayerCard(player, index, profiles) {
  return `<fieldset class="player-setup-card single-player-card"><legend><span>${index + 1}</span> ${t("common.player")} ${index + 1}</legend><label>${t("common.savedPlayer")}<select data-setup-profile="${index}"><option value="">${t("common.newName")}</option>${profiles.map((profile) => `<option value="${profile.id}" ${player.profileId === profile.id ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}</select></label><label>${t("common.name")}<input data-setup-name="${index}" maxlength="24" value="${escapeHtml(player.name)}" placeholder="${t("common.namePlaceholder")}" ${player.profileId ? "readonly" : ""} /></label>${player.profileId ? `<p class="profile-note">${t("common.savedProfile")}</p>` : `<label class="check-label"><input type="checkbox" data-setup-remember="${index}" ${player.remember ? "checked" : ""}/> ${t("common.remember")}</label>`}</fieldset>`;
}

function renderPlayersSetup() {
  const profiles = sortProfilesByRecentUse(data.profiles);
  const player = ui.setupPlayers[ui.setupIndex];
  const completed = ui.setupPlayers.slice(0, ui.setupIndex).filter((item) => item.name.trim());
  return `<main class="centered-page setup-page"><section class="panel narrow"><p class="eyebrow">${t("setup.playerStep")}</p><h1>${t("setup.orderTitle")}</h1><p class="lead">${t("setup.orderHelp")}</p><div class="setup-progress" aria-label="${t("setup.position", { current: ui.setupIndex + 1, total: ui.playerCount })}">${ui.setupPlayers.map((_, index) => `<span class="${index < ui.setupIndex ? "done" : index === ui.setupIndex ? "current" : ""}">${index + 1}</span>`).join("")}</div>${completed.length ? `<p class="entered-players">${completed.map((item, index) => `<span>${index + 1}. ${escapeHtml(item.name)}</span>`).join("")}</p>` : ""}<form id="player-form">${setupPlayerCard(player, ui.setupIndex, profiles)}${ui.error ? `<p class="form-error" role="alert">${escapeHtml(ui.error)}</p>` : ""}<div class="setup-nav">${ui.setupIndex > 0 ? `<button class="button quiet" type="button" data-action="previous-player">← ${t("setup.previous")}</button>` : "<span></span>"}<button class="button primary large" type="submit">${ui.setupIndex === ui.playerCount - 1 ? t("setup.start") : `${t("setup.next")} →`}</button></div></form></section></main>`;
}

function materializedGame() {
  const game = data.activeGame;
  return { game, players: materializePlayers(game.basePlayers, game.timeline) };
}

function entryMarkup(entry, playable) {
  if (entry?.kind === "score") return `<span class="score-value">${entry.score}</span>`;
  if (entry?.kind === "sacrifice") return `<span class="sacrifice-mark" aria-label="${t("game.sacrificed")}">╱</span>`;
  return playable ? '<span class="playable-dot">＋</span>' : '<span class="empty-mark">·</span>';
}

function scoreCell(player, playerIndex, columnId, category, activeIndex) {
  const entry = player.columns[columnId][category.id];
  const active = playerIndex === activeIndex;
  const playable = active && isCellPlayable(player, columnId, category.id);
  const classes = ["player-cell", active ? "active-player" : "", playable ? "is-playable" : "", entry?.kind === "sacrifice" ? "is-sacrificed" : "", entry?.kind === "score" ? "is-scored" : ""].filter(Boolean).join(" ");
  return `<td class="${classes}"><button class="score-cell" ${playable ? `data-action="open-score" data-player="${playerIndex}" data-column="${columnId}" data-category="${category.id}"` : "disabled"} aria-label="${escapeHtml(player.name)}, ${columnLabel(columnId)}, ${categoryText(category.id, "label")}">${entryMarkup(entry, playable)}</button></td>`;
}

function computedCell(player, columnId, kind, active) {
  const summary = columnSummary(player.columns[columnId]);
  let content = "";
  let extra = "";
  if (kind === "upper") { content = summary.upper.complete ? summary.upper.subtotal : `${summary.upper.trend >= 0 ? "+" : ""}${summary.upper.trend}`; extra = summary.upper.complete ? "" : "trend"; }
  else if (kind === "bonus") { if (summary.upper.bonus.status === "earned") content = "30"; else if (summary.upper.bonus.status === "lost") { content = "╱"; extra = "is-sacrificed"; } }
  else if (kind === "total") content = summary.total ?? "";
  return `<td class="computed-cell player-cell ${active ? "active-player" : ""} ${extra}">${content}</td>`;
}

function computedLabel(label, ruleId = null) {
  return ruleId ? `<button class="computed-label" data-action="computed-rule" data-rule="${ruleId}">${label}<span aria-hidden="true">?</span></button>` : label;
}

function renderGameTable(players, activeIndex) {
  const head = players.map((player, index) => `<th class="player-head ${index === activeIndex ? "active-player-head" : ""}" colspan="2"><span>${escapeHtml(player.name)}</span><small>${index === activeIndex ? t("game.yourTurn") : t("game.playerNumber", { count: index + 1 })}</small></th>`).join("");
  const subhead = players.map((_, index) => `<th class="column-head player-cell ${index === activeIndex ? "active-player" : ""}">${t("common.order").slice(0, 1)}</th><th class="column-head player-cell ${index === activeIndex ? "active-player" : ""}">${t("common.disorder").slice(0, 1)}</th>`).join("");
  const row = (category, sectionStart = false) => `<tr class="category-row${sectionStart ? " section-start" : ""}"><th scope="row"><button class="category-label" data-action="category-rule" data-category="${category.id}"><span>${categoryText(category.id, "label")}</span>${category.fixed ? `<small>${category.fixed} ${t("common.points")}</small>` : ""}</button></th>${players.map((player, playerIndex) => COLUMN_IDS.map((columnId) => scoreCell(player, playerIndex, columnId, category, activeIndex)).join("")).join("")}</tr>`;
  const computed = (label, kind, className = "", ruleId = null) => `<tr class="computed-row ${className}"><th scope="row">${computedLabel(label, ruleId)}</th>${players.map((player, index) => COLUMN_IDS.map((columnId) => computedCell(player, columnId, kind, index === activeIndex)).join("")).join("")}</tr>`;
  const general = `<tr class="computed-row general-row"><th scope="row">${t("game.generalTotal")}</th>${players.map((_, index) => `<td colspan="2" class="player-cell ${index === activeIndex ? "active-player" : ""}"><span class="hidden-total">${t("common.reveal")}</span></td>`).join("")}</tr>`;
  return `<div class="score-table-wrap"><table class="score-table"><thead><tr><th rowspan="2" class="category-corner">${t("common.category")}</th>${head}</tr><tr>${subhead}</tr></thead><tbody>${CATEGORIES.slice(0, 6).map((category) => row(category)).join("")}${computed(t("game.totalIntermediate"), "upper", "upper-total", "upper")}${computed(t("game.bonus"), "bonus", "bonus-row", "bonus")}${CATEGORIES.slice(6).map((category, index) => row(category, index === 0)).join("")}${computed(t("game.columnTotal"), "total", "column-total")}${general}</tbody></table></div>`;
}

function turnNoticeMarkup() {
  if (!ui.turnNotice) return "";
  const notice = ui.turnNotice;
  const category = categoryById(notice.categoryId);
  const message = notice.entry.kind === "sacrifice" ? t("turnNotice.sacrifice", { name: notice.playerName, category: categoryText(category.id, "label") }) : category.kind === "fixed" ? t("turnNotice.fixed", { name: notice.playerName, category: categoryText(category.id, "label") }) : t("turnNotice.score", { name: notice.playerName, score: notice.entry.score, category: categoryText(category.id, "label") });
  return `<div class="turn-notice" role="status"><strong>${escapeHtml(message)}</strong><span>${t("turnNotice.column", { column: columnLabel(notice.columnId) })}</span><small>${t("turnNotice.next", { name: escapeHtml(notice.nextName) })}</small></div>`;
}

function renderGame() {
  const { game, players } = materializedGame();
  const activeIndex = activePlayerIndex(players.length, game.timeline.cursor);
  const active = players[activeIndex];
  return `<div class="game-shell ${ui.turnNotice ? "turn-changing" : ""}"><header class="game-toolbar"><button class="brand" data-action="quit-game"><span class="mini-die">⚄</span><span>Yam’s</span></button><div class="turn-identity"><small>${t("game.turn")}</small><strong>${escapeHtml(active.name)}</strong><span>${t("game.entry", { count: game.timeline.cursor + 1 })}</span></div><div class="game-actions"><button class="toolbar-button" data-action="roll-helper"><b class="toolbar-symbol">⚄</b><span>${t("game.analyze")}</span></button><button class="toolbar-button" data-action="undo" ${game.timeline.cursor === 0 ? "disabled" : ""}>↶ <span>${t("game.undo")}</span></button><button class="toolbar-button" data-action="redo" ${game.timeline.cursor === game.timeline.events.length ? "disabled" : ""}>↷ <span>${t("game.redo")}</span></button><button class="toolbar-button" data-action="rules">? <span>${t("common.rules")}</span></button><button class="toolbar-button" data-action="quit-game">⌂ <span>${t("game.quit")}</span></button></div></header><main class="game-main"><div class="turn-mobile"><small>${t("game.turn")}</small><strong>${escapeHtml(active.name)}</strong></div>${renderGameTable(players, activeIndex)}<p class="game-hint">${t("game.hint")}</p></main>${turnNoticeMarkup()}${renderModal()}</div>`;
}

function rulesBody() {
  return `<section class="rules-intro"><h2>${t("rules.playTitle")}</h2><p>${t("rules.play")}</p></section><section class="rules-grid">${CATEGORIES.map((category) => `<article class="rule-card"><div><h3>${categoryText(category.id, "label")}</h3>${category.fixed ? `<span>${t("rules.fixed", { score: category.fixed })}</span>` : ""}</div><p>${categoryText(category.id, "help")}</p></article>`).join("")}</section><section class="rules-intro"><h2>${t("rules.bonusTitle")}</h2><p>${t("rules.bonus")}</p></section>`;
}

function renderRules() { return `<main class="content-page"><p class="eyebrow">${t("rules.eyebrow")}</p><h1>${t("rules.title")}</h1><p class="lead">${escapeHtml(ui.tagline)}</p>${rulesBody()}</main>`; }

function recordCard(label, record, key) {
  return `<article class="record-card"><span>${label}</span>${record ? `<strong>${record[key]}</strong><p>${escapeHtml(record.name)} · ${formatDate(record.date)}</p>` : `<strong>—</strong><p>${t("stats.noCompleted")}</p>`}</article>`;
}

function renderStatistics() {
  const stats = buildStatistics(data.pastGames, data.profiles, data.activeGame);
  return `<main class="content-page stats-page"><p class="eyebrow">${t("stats.eyebrow")}</p><h1>${t("stats.title")}</h1><section class="stat-counts"><article><strong>${stats.counts.started}</strong><span>${tp("stats.started", stats.counts.started)}</span></article><article><strong>${stats.counts.completed}</strong><span>${tp("stats.completed", stats.counts.completed)}</span></article><article><strong>${stats.counts.abandoned}</strong><span>${tp("stats.abandoned", stats.counts.abandoned)}</span></article></section><h2>${t("stats.records")}</h2><section class="records-grid">${recordCard(t("stats.highTotal"), stats.records.highestGeneral, "general")}${recordCard(t("stats.highOrder"), stats.records.highestOrder, "order")}${recordCard(t("stats.highDisorder"), stats.records.highestDisorder, "disorder")}${recordCard(t("stats.lowTotal"), stats.records.lowestGeneral, "general")}</section><h2>${t("stats.top")}</h2><section class="ranking-list">${stats.topTen.length ? stats.topTen.map((entry, index) => `<article><span class="rank">${index + 1}</span><div><strong>${escapeHtml(entry.name)}</strong><small>${formatDate(entry.date)}</small></div><b>${entry.general}</b></article>`).join("") : `<p class="empty-state">${t("stats.topEmpty")}</p>`}</section><h2>${t("stats.savedPlayers")}</h2><section class="ranking-list">${stats.playerRanking.length ? stats.playerRanking.map((entry, index) => `<article><span class="rank">${index + 1}</span><div><strong>${escapeHtml(entry.profile.name)}</strong><small>${tp("stats.games", entry.games)} · ${tp("stats.wins", entry.wins)}</small></div><b>${entry.best}</b></article>`).join("") : `<p class="empty-state">${t("stats.playersEmpty")}</p>`}</section></main>`;
}

function renderResults() {
  const completed = ui.completed;
  if (!completed) return `<main class="content-page"><h1>${t("results.none")}</h1></main>`;
  return `<main class="results-page"><p class="eyebrow">${t("results.eyebrow")}</p><h1>${t("results.title")}</h1><p class="lead">${escapeHtml(ui.tagline)}</p><section class="final-ranking">${completed.record.results.map((result, index) => { const badges = completed.badges.filter((badge) => badge.playerId === result.playerId); return `<article class="final-result rank-${result.rank}" style="--delay:${index * 90}ms"><span class="podium-rank">${result.rank}</span><div class="result-player"><strong>${escapeHtml(result.name)}</strong><small>${t("results.details", { order: result.order, disorder: result.disorder })}</small>${badges.map((badge) => `<em>✦ ${t(`results.records.${badge.type}`)}</em>`).join("")}</div><b>${result.general}</b></article>`; }).join("")}</section><div class="results-actions"><button class="button primary large" data-action="home">${t("results.home")}</button><button class="button secondary large" data-action="stats">${t("results.stats")}</button><button class="button quiet large full-span" data-action="correct-last">↶ ${t("results.correct")}</button></div></main>`;
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
  else if (category.kind === "fixed") input = `<button class="button success large full" data-action="commit-score" data-score="${category.fixed}">${t("scoreModal.fixed", { score: category.fixed })}</button>`;
  else if (options.length === 0) input = `<p class="constraint-warning">${t("scoreModal.impossible")}</p>`;
  else input = `<form id="variable-score-form"><label class="numeric-label">${t("scoreModal.range", { min: range.min, max: range.max })}<input id="variable-score" name="score" type="number" inputmode="numeric" min="${range.min}" max="${range.max}" required /></label><button class="button success large" type="submit">${t("common.validate")}</button></form>`;
  return dialogFrame(`<p class="eyebrow">${escapeHtml(player.name)} · ${columnLabel(modal.columnId)}</p><h2>${categoryText(category.id, "label")}</h2><p class="dialog-help">${categoryText(category.id, "help")}</p>${input}<button class="button danger-outline full" data-action="sacrifice">╱ ${t("common.sacrifice")}</button>`, t("scoreModal.title"));
}

function rollHelperModal() {
  const { game, players } = materializedGame();
  const active = players[activePlayerIndex(players.length, game.timeline.cursor)];
  const suggestions = analyzeRoll(active, ui.dice);
  return dialogFrame(`<div class="roll-layout"><div class="roll-fixed"><p class="eyebrow">${t("analyzer.eyebrow", { name: escapeHtml(active.name) })}</p><h2>${t("analyzer.title")}</h2><p class="dialog-help">${t("analyzer.help")}</p><div class="dice-row">${ui.dice.map((die, index) => `<button class="die-button" data-action="cycle-die" data-die="${index}" aria-label="${t("analyzer.die", { index: index + 1, value: die })}">${DICE_GLYPHS[die - 1]}</button>`).join("")}</div></div><div class="suggestions-area"><div class="suggestions">${suggestions.length ? suggestions.map((item) => { const warning = (item.categoryId === "minus" && item.score === 30) || (item.categoryId === "plus" && item.score === 19); return `<button class="suggestion" data-action="select-suggestion" data-column="${item.columnId}" data-category="${item.categoryId}" data-score="${item.score}"><span><strong>${categoryText(item.categoryId, "label")}</strong><small>${columnLabel(item.columnId)}${warning ? ` · ${t("analyzer.warning")}` : ""}</small></span><b>${item.score}</b></button>`; }).join("") : `<p class="no-suggestion">${t("analyzer.none")}</p>`}</div></div></div>`, t("analyzer.dialog"), "roll-modal-card");
}

function rollConfirmModal(modal) {
  const { game, players } = materializedGame();
  const player = players[activePlayerIndex(players.length, game.timeline.cursor)];
  return dialogFrame(`<p class="eyebrow">${t("analyzer.eyebrow", { name: escapeHtml(player.name) })}</p><h2>${t("analyzer.confirmTitle")}</h2><p class="dialog-help rule-detail">${t("analyzer.confirmText", { score: modal.score, category: categoryText(modal.categoryId, "label"), column: columnLabel(modal.columnId), name: escapeHtml(player.name) })}</p><div class="dialog-actions"><button class="button quiet" data-action="back-to-roll">${t("analyzer.back")}</button><button class="button primary large" data-action="confirm-suggestion">${t("analyzer.apply")}</button></div>`, t("analyzer.confirmTitle"));
}

function dialogFrame(content, label, className = "") {
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card ${className}" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}" data-modal-card><button class="modal-close" data-action="close-modal" aria-label="${t("common.close")}">×</button>${content}</section></div>`;
}

function renderModal() {
  if (!ui.modal) return "";
  if (ui.modal.type === "score") return scoreModal(ui.modal);
  if (ui.modal.type === "roll") return rollHelperModal();
  if (ui.modal.type === "roll-confirm") return rollConfirmModal(ui.modal);
  if (ui.modal.type === "abandon") return dialogFrame(`<p class="eyebrow">${t("abandon.eyebrow")}</p><h2>${t("abandon.title")}</h2><p class="dialog-help">${t("abandon.help")}</p><div class="dialog-actions"><button class="button quiet" data-action="close-modal">${t("abandon.keep")}</button><button class="button danger" data-action="confirm-abandon">${t("abandon.confirm")}</button></div>`, t("abandon.dialog"));
  if (ui.modal.type === "category") { const category = categoryById(ui.modal.categoryId); return dialogFrame(`<p class="eyebrow">${t("common.rules")}</p><h2>${categoryText(category.id, "label")}</h2><p class="dialog-help rule-detail">${categoryText(category.id, "help")}</p>${category.fixed ? `<p class="fixed-score-callout">${t("rules.fixed", { score: category.fixed })}</p>` : ""}`, categoryText(category.id, "label")); }
  if (ui.modal.type === "computed") { const bonus = ui.modal.ruleId === "bonus"; return dialogFrame(`<p class="eyebrow">${t("common.rules")}</p><h2>${t(bonus ? "game.bonus" : "rules.upperTitle")}</h2><p class="dialog-help rule-detail">${t(bonus ? "rules.bonusDetail" : "rules.upperDetail")}</p>`, t(bonus ? "game.bonus" : "rules.upperTitle")); }
  return "";
}

function beginSetup() {
  ui.playerCount = 4; ui.setupPlayers = []; ui.setupIndex = 0;
  navigate("setup-count");
}

async function startGame() {
  const usedAt = new Date().toISOString();
  const basePlayers = ui.setupPlayers.map((player) => ({ id: id("player"), name: player.name.trim(), profileId: player.profileId || (player.remember ? player.id : null) }));
  data.profiles = updateRememberedProfiles(data.profiles, ui.setupPlayers, usedAt);
  data.activeGame = { id: id("game"), status: "active", createdAt: usedAt, basePlayers, timeline: { events: [], cursor: 0 } };
  await persist();
  requestPersistentStorage();
  navigate("game", { replace: true });
}

async function advancePlayerSetup() {
  const player = ui.setupPlayers[ui.setupIndex];
  if (!player.name.trim()) { ui.error = t("setup.missingName"); render(); return; }
  ui.error = "";
  if (ui.setupIndex === ui.playerCount - 1) await startGame();
  else { ui.setupIndex += 1; render(); }
}

async function commitEntry(entry) {
  const modal = ui.modal;
  if (!modal || !["score", "roll-confirm"].includes(modal.type)) return;
  const { game, players } = materializedGame();
  const activeIndex = activePlayerIndex(players.length, game.timeline.cursor);
  const player = players[activeIndex];
  const playerIndex = modal.type === "score" ? modal.playerIndex : activeIndex;
  if (playerIndex !== activeIndex || !isCellPlayable(player, modal.columnId, modal.categoryId)) return;
  if (entry.kind === "score" && !validateScore(modal.categoryId, entry.score, player.columns[modal.columnId])) return;
  const previousStats = buildStatistics(data.pastGames, data.profiles);
  game.timeline = appendTimelineEvent(game.timeline, { id: id("event"), playerId: player.id, columnId: modal.columnId, categoryId: modal.categoryId, entry, createdAt: new Date().toISOString() });
  data.activeGame = game;
  ui.modal = null;
  history.replaceState(historyState(), "");
  const updatedPlayers = materializePlayers(game.basePlayers, game.timeline);
  if (isGameComplete(updatedPlayers)) {
    const record = completedGameRecord(game, updatedPlayers, new Date().toISOString());
    const badges = newRecordBadges(previousStats, record.results);
    data.pastGames.push(record); data.activeGame = null; ui.completed = { record, badges }; ui.screen = "results"; refreshTagline("results"); history.replaceState(historyState(), "");
  } else {
    const nextIndex = activePlayerIndex(updatedPlayers.length, game.timeline.cursor);
    ui.turnNotice = { playerName: player.name, nextName: updatedPlayers[nextIndex].name, columnId: modal.columnId, categoryId: modal.categoryId, entry };
  }
  await persist();
  render();
  if (ui.turnNotice) { clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { ui.turnNotice = null; noticeTimer = null; if (ui.screen === "game") render(); }, 1450); }
}

async function moveHistory(direction) {
  if (!data.activeGame) return;
  clearTurnNotice();
  data.activeGame.timeline = direction === "undo" ? undoTimeline(data.activeGame.timeline) : redoTimeline(data.activeGame.timeline);
  await persist(); render();
}

window.addEventListener("popstate", (event) => {
  if (!event.state?.yams) return;
  const previousScreen = ui.screen;
  const target = event.state;
  const hadModal = Boolean(ui.modal);
  if (hadModal) ui.modal = null;
  if (previousScreen === "game" && !hadModal) {
    clearTurnNotice();
    if (target.depth > 0) { history.go(-target.depth); return; }
    ui.screen = "home"; navDepth = 0; refreshTagline("home");
  } else {
    ui.screen = target.screen; navDepth = target.depth ?? 0;
    if (["home", "rules", "results"].includes(ui.screen)) refreshTagline(ui.screen);
  }
  render();
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "home") returnHome();
  else if (action === "back") history.back();
  else if (action === "resume") navigate("game");
  else if (action === "new-game") data.activeGame ? openModal({ type: "abandon" }) : beginSetup();
  else if (action === "confirm-abandon") { data = archiveActiveGame(data, "abandoned", new Date().toISOString()); await persist(); ui.modal = null; history.replaceState(historyState(), ""); beginSetup(); }
  else if (action === "set-count") { ui.playerCount = Number(button.dataset.count); render(); }
  else if (action === "continue-setup") { ui.setupPlayers = Array.from({ length: ui.playerCount }, () => ({ id: id("profile"), profileId: null, name: "", remember: false })); ui.setupIndex = 0; navigate("setup-players"); }
  else if (action === "previous-player") { ui.setupIndex = Math.max(0, ui.setupIndex - 1); ui.error = ""; render(); }
  else if (action === "rules") navigate("rules");
  else if (action === "stats") navigate("stats");
  else if (action === "correct-last" && ui.completed) { const record = ui.completed.record; data.pastGames = data.pastGames.filter((game) => game.id !== record.id); data.activeGame = { ...record, status: "active", endedAt: undefined, results: undefined, timeline: undoTimeline(record.timeline) }; ui.completed = null; await persist(); navigate("game", { replace: true }); }
  else if (action === "quit-game") returnHome();
  else if (action === "undo" || action === "redo") await moveHistory(action);
  else if (action === "open-score") openModal({ type: "score", playerIndex: Number(button.dataset.player), columnId: button.dataset.column, categoryId: button.dataset.category });
  else if (action === "commit-score") await commitEntry(scoreEntry(Number(button.dataset.score)));
  else if (action === "sacrifice") await commitEntry(sacrificeEntry());
  else if (action === "close-modal" && (event.target === button || button.classList.contains("modal-close") || button.tagName === "BUTTON")) closeModal();
  else if (action === "category-rule") openModal({ type: "category", categoryId: button.dataset.category });
  else if (action === "computed-rule") openModal({ type: "computed", ruleId: button.dataset.rule });
  else if (action === "roll-helper") { ui.dice = [1, 1, 1, 1, 1]; openModal({ type: "roll" }); }
  else if (action === "cycle-die") { const index = Number(button.dataset.die); ui.dice[index] = (ui.dice[index] % 6) + 1; render(); }
  else if (action === "select-suggestion") replaceModal({ type: "roll-confirm", columnId: button.dataset.column, categoryId: button.dataset.category, score: Number(button.dataset.score) });
  else if (action === "back-to-roll") replaceModal({ type: "roll" });
  else if (action === "confirm-suggestion") await commitEntry(scoreEntry(ui.modal.score));
});

app.addEventListener("change", async (event) => {
  if (event.target.matches("[data-language]")) { data.settings.locale = setLocale(event.target.value); refreshTagline("home"); await persist(); render(); return; }
  const profileIndex = event.target.dataset.setupProfile;
  const rememberIndex = event.target.dataset.setupRemember;
  if (profileIndex !== undefined) {
    const index = Number(profileIndex);
    const profile = data.profiles.find((item) => item.id === event.target.value);
    ui.setupPlayers[index].profileId = profile?.id ?? null; ui.setupPlayers[index].name = profile?.name ?? ""; ui.setupPlayers[index].remember = false; render();
  } else if (rememberIndex !== undefined) ui.setupPlayers[Number(rememberIndex)].remember = event.target.checked;
});

app.addEventListener("input", (event) => {
  const index = event.target.dataset.setupName;
  if (index !== undefined) ui.setupPlayers[Number(index)].name = event.target.value;
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "player-form") await advancePlayerSetup();
  if (event.target.id === "variable-score-form") await commitEntry(scoreEntry(Number(new FormData(event.target).get("score") ?? document.querySelector("#variable-score")?.value)));
});

init();
