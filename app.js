import {
  CATEGORIES, activePlayerIndex, allowedRange, analyzeRoll,
  appendTimelineEvent, categoryById, columnSummary, isCellPlayable,
  isGameComplete, materializePlayers, redoTimeline, sacrificeEntry,
  scoreEntry, scoreOptions, undoTimeline, validateScore,
  GAME_FORMATS, gameFormat, columnsForFormat,
} from "./scoring.js";
import {
  archiveActiveGame, loadAppData, requestPersistentStorage, saveAppData,
  sortProfilesByRecentUse, updateRememberedProfiles,
} from "./storage.js";
import { buildStatistics, completedGameRecord, newRecordBadges, interruptedGameRecord } from "./statistics.js";
import {
  categoryText, detectLocale, localeCode, localeOptions, randomLine,
  setLocale, t, tp,
} from "./i18n.js";

import { createPeer, decodeSignal, PAIRING_BUILD } from "./sharing.js";
import { BUILD_NUMBER, DIAGNOSTICS_ENABLED } from "./build-profile.js";
import { drawQR, scanQR } from "./qr-camera.js";
import { createWakeLock } from "./wake-lock.js";

const wakeLock = createWakeLock();
const app = document.querySelector("#app");
const DICE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const TURN_NOTICE_DURATION_MS = 5000;

let data;
let navDepth = 0;
let noticeTimer = null;
let lastFocusedTurn = null;
const managerPeers = new Set();
let observerPeer = null;
let stopScanner = null;
let scoringBusy = false;
const ui = {
  screen: "home", playerCount: 4, setupPlayers: [], setupIndex: 0,
  modal: null, dice: [1, 1, 1, 1, 1], completed: null,
  error: "", tagline: "", turnNotice: null, format: "classic", statsFormat: "classic",
  observation: null, pairing: null, banner: "", lastDiagnostic: null,
};
let diagnosticUpload = { status: 'idle', key: null, reportId: null };
let diagnosticTools = null, diagnosticToolsPromise = null, diagnosticShare = null;
let diagnosticRecipientEditing = false, diagnosticRecipientMessage = '', diagnosticRecipientDraft = '';
let internalTest = {status:'idle',result:null};

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
  clearTurnNotice();
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
  if (ui.modal?.type === "share") cancelPairing();
  if (ui.modal && navDepth > 0) history.back();
  else { ui.modal = null; render(); }
}

function clearTurnNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  ui.turnNotice = null;
}

function returnHome() {
  leaveSharing();
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
    ${content}${ui.screen === "results" ? turnNoticeMarkup() : ""}${renderModal()}
  </div>`;
}

function captureScrollState() {
  const table = document.querySelector(".score-table-wrap");
  return table ? { tableTop: table.scrollTop, tableLeft: table.scrollLeft, windowX: window.scrollX, windowY: window.scrollY } : null;
}

function render() {
  stopScanner?.(); stopScanner = null;
  const scrollState = captureScrollState();
  if (ui.screen === "home") app.innerHTML = shell(renderHome(), { compact: true });
  else if (ui.screen === "setup-count") app.innerHTML = shell(renderCountSetup(), { back: true, compact: true });
  else if (ui.screen === "setup-players") app.innerHTML = shell(renderPlayersSetup(), { back: true, compact: true });
  else if (ui.screen === "game") app.innerHTML = renderGame();
  else if (ui.screen === "rules") app.innerHTML = shell(renderRules(), { back: true, showRules: false });
  else if (ui.screen === "stats") app.innerHTML = shell(renderStatistics(), { back: true });
  else if (ui.screen === "results") app.innerHTML = shell(renderResults());
  if (ui.screen !== "game") lastFocusedTurn = null;
  afterRender(scrollState);
}

function afterRender(scrollState) {
  updateWakeLock();
  renderPairingMedia();
  if (ui.screen === "game") {
    const currentGame = ui.observation?.game ?? data.activeGame;
    const turnKey = currentGame ? `${currentGame.id}:${ui.observation?.selected !== "turn" && ui.observation ? ui.observation.selected : currentGame.timeline.cursor}` : null;
    const focusNewTurn = !ui.modal && turnKey !== lastFocusedTurn;
    if (focusNewTurn) lastFocusedTurn = turnKey;
    requestAnimationFrame(() => {
      const table = document.querySelector(".score-table-wrap");
      if (!table) return;
      if (focusNewTurn) document.querySelector(".active-player-head")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
      if (scrollState) {
        table.scrollTop = scrollState.tableTop;
        if (!focusNewTurn) table.scrollLeft = scrollState.tableLeft;
        window.scrollTo(scrollState.windowX, scrollState.windowY);
      }
    });
  }
  if (ui.modal?.type === "score") requestAnimationFrame(() => document.querySelector("#variable-score")?.focus());
}

function updateWakeLock() { wakeLock.update(ui.screen === "game" && data.settings.keepAwake && document.visibilityState === "visible"); }
matchMedia("(max-width: 650px)").addEventListener("change", () => { if (ui.screen === "game") render(); });
document.addEventListener("visibilitychange", () => { if (data) updateWakeLock(); });
window.addEventListener("pagehide", () => wakeLock.update(false));

function formatPicker(value, attribute) {
  return `<label class="format-picker">${t("v3.format")}<select ${attribute}>${GAME_FORMATS.map((format) => `<option value="${format}" ${value === format ? "selected" : ""}>${t(`v3.formats.${format}`)}</option>`).join("")}</select></label>`;
}

function languagePicker() {
  return `<label class="language-picker"><span>${t("home.language")}</span><select data-language>${localeOptions().map(({ code, label }) => `<option value="${code}" ${code === localeCode() ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
}

function renderHome() {
  return `<main class="home-screen"><section class="hero-card">
    <div class="brand-die hero-die" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <p class="eyebrow">${t("home.eyebrow")}</p><h1>Yam’s</h1><p class="lead">${escapeHtml(ui.tagline)}</p>
    <div class="home-actions">${ui.banner ? `<p class="constraint-warning" role="status">${escapeHtml(ui.banner)}</p>` : ""}${data.activeGame ? `<button class="button primary large" data-action="resume">${t("home.resume")}</button>` : ""}<button class="button ${data.activeGame ? "secondary" : "primary"} large" data-action="new-game">${t("home.newGame")}</button><button class="button secondary large" data-action="join-game">${t("v3.join")}</button><div class="action-pair"><button class="button quiet" data-action="rules">${t("home.readRules")}</button><button class="button quiet" data-action="stats">${t("home.statistics")}</button></div>${languagePicker()}</div>
    ${data.activeGame ? `<p class="saved-note">${t("home.saved", { players: data.activeGame.basePlayers.length, scores: data.activeGame.timeline.cursor })}</p>` : `<p class="saved-note">${t("home.offline")}</p>`}
  </section>${DIAGNOSTICS_ENABLED ? `<footer class="test-footer"><p>${t('v3.testVersion',{version:BUILD_NUMBER})}</p><div data-internal-test-controls>${internalTestControls()}</div><div data-debug-last>${lastDiagnosticControls()}</div></footer>` : ''}</main>`;
}

function renderCountSetup() {
  return `<main class="centered-page setup-page"><section class="panel narrow"><p class="eyebrow">${t("setup.countStep")}</p><h1>${t("setup.howMany")}</h1><p class="lead">${t("setup.countHelp")}</p><div class="count-picker" role="group" aria-label="${t("setup.countLabel")}">${Array.from({ length: 12 }, (_, index) => index + 1).map((count) => `<button class="count-button ${ui.playerCount === count ? "selected" : ""}" data-action="set-count" data-count="${count}">${count}</button>`).join("")}</div>${formatPicker(ui.format, "data-format")}<p class="format-help">${t("v3.formatHelp", { count: columnsForFormat(ui.format).length * 16 })}</p><button class="button primary large full" data-action="continue-setup">${t("setup.continue", { count: ui.playerCount })} ${tp("setup.players", ui.playerCount)}</button></section></main>`;
}

function selectedSetupPlayer(player) {
  const profile = !player.newPlayer && data.profiles.find((item) => item.id === player.profileId);
  return {
    id: player.id,
    profileId: profile?.id ?? null,
    name: player.newPlayer ? player.name : profile?.name ?? "",
    remember: player.newPlayer && player.remember,
  };
}

function availableSetupProfiles(index) {
  const selectedIds = new Set(ui.setupPlayers.slice(0, index)
    .filter((player) => !player.newPlayer).map((player) => player.profileId));
  return sortProfilesByRecentUse(data.profiles).filter((profile) => !selectedIds.has(profile.id));
}

function setupPlayerCard(player, index, profiles) {
  const isNew = player.newPlayer;
  return `<fieldset class="player-setup-card single-player-card"><legend><span>${index + 1}</span> ${t("common.player")} ${index + 1}</legend>
    ${profiles.length ? `<label class="${isNew ? "is-disabled" : ""}">${t("common.savedPlayer")}<select data-setup-profile="${index}" ${isNew ? "disabled" : ""}>${profiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${player.profileId === profile.id ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}</select></label>` : ""}
    <label class="check-label"><input type="checkbox" data-setup-new="${index}" ${isNew ? "checked" : ""} ${profiles.length ? "" : "disabled"}/> ${t("common.newPlayer")}</label>
    <label class="${isNew ? "" : "is-disabled"}">${t("common.name")}<input data-setup-name="${index}" maxlength="24" value="${escapeHtml(player.name)}" placeholder="${t("common.namePlaceholder")}" ${isNew ? "" : "disabled"} /></label>
    <label class="check-label ${isNew ? "" : "is-disabled"}"><input type="checkbox" data-setup-remember="${index}" ${player.remember ? "checked" : ""} ${isNew ? "" : "disabled"}/> ${t("common.remember")}</label>
  </fieldset>`;
}

function renderPlayersSetup() {
  const profiles = availableSetupProfiles(ui.setupIndex);
  const player = ui.setupPlayers[ui.setupIndex];
  // Reconcile this step after an earlier choice changes, without losing new-name drafts.
  if (!profiles.some((profile) => profile.id === player.profileId)) player.profileId = profiles[0]?.id ?? null;
  if (!profiles.length) player.newPlayer = true;
  const completed = ui.setupPlayers.slice(0, ui.setupIndex).map(selectedSetupPlayer).filter((item) => item.name.trim());
  return `<main class="centered-page setup-page"><section class="panel narrow"><p class="eyebrow">${t("setup.playerStep")}</p><h1>${t("setup.orderTitle")}</h1><p class="lead">${t("setup.orderHelp")}</p><div class="setup-progress" aria-label="${t("setup.position", { current: ui.setupIndex + 1, total: ui.playerCount })}">${ui.setupPlayers.map((_, index) => `<span class="${index < ui.setupIndex ? "done" : index === ui.setupIndex ? "current" : ""}">${index + 1}</span>`).join("")}</div>${completed.length ? `<p class="entered-players">${completed.map((item, index) => `<span>${index + 1}. ${escapeHtml(item.name)}</span>`).join("")}</p>` : ""}<form id="player-form">${setupPlayerCard(player, ui.setupIndex, profiles)}${ui.error ? `<p class="form-error" role="alert">${escapeHtml(ui.error)}</p>` : ""}<div class="setup-nav">${ui.setupIndex > 0 ? `<button class="button quiet" type="button" data-action="previous-player">← ${t("setup.previous")}</button>` : "<span></span>"}<button class="button primary large" type="submit">${ui.setupIndex === ui.playerCount - 1 ? t("setup.start") : `${t("setup.next")} →`}</button></div></form></section></main>`;
}

function materializedGame() {
  const game = ui.observation?.game ?? data.activeGame;
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
  const playable = !ui.observation && active && isCellPlayable(player, columnId, category.id);
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

function renderGameTable(players, activeIndex, turnIndex = activeIndex) {
  const columns = columnsForFormat(ui.observation?.game ?? data.activeGame);
  const head = players.map((player, index) => `<th class="player-head ${index === activeIndex ? "active-player-head" : ""}" colspan="${columns.length}"><span>${escapeHtml(player.name)}</span><small>${index === turnIndex ? t("game.yourTurn") : t("game.playerNumber", { count: index + 1 })}</small></th>`).join("");
  const subhead = players.map((_, index) => columns.map((column) => `<th class="column-head player-cell ${index === activeIndex ? "active-player" : ""}">${columnLabel(column).slice(0, 1)}</th>`).join("")).join("");
  const row = (category, sectionStart = false) => `<tr class="category-row${sectionStart ? " section-start" : ""}"><th scope="row"><button class="category-label" data-action="category-rule" data-category="${category.id}"><span>${categoryText(category.id, "label")}</span>${category.fixed ? `<small>${category.fixed} ${t("common.points")}</small>` : ""}</button></th>${players.map((player, playerIndex) => columns.map((columnId) => scoreCell(player, playerIndex, columnId, category, activeIndex)).join("")).join("")}</tr>`;
  const computed = (label, kind, className = "", ruleId = null) => `<tr class="computed-row ${className}"><th scope="row">${computedLabel(label, ruleId)}</th>${players.map((player, index) => columns.map((columnId) => computedCell(player, columnId, kind, index === activeIndex)).join("")).join("")}</tr>`;
  const general = `<tr class="computed-row general-row"><th scope="row">${t("game.generalTotal")}</th>${players.map((_, index) => `<td colspan="${columns.length}" class="player-cell ${index === activeIndex ? "active-player" : ""}"><span class="hidden-total">${t("common.reveal")}</span></td>`).join("")}</tr>`;
  return `<div class="score-table-wrap"><table class="score-table"><thead><tr><th rowspan="2" class="category-corner">${t("common.category")}</th>${head}</tr><tr>${subhead}</tr></thead><tbody>${CATEGORIES.slice(0, 6).map((category) => row(category)).join("")}${computed(t("game.totalIntermediate"), "upper", "upper-total", "upper")}${computed(t("game.bonus"), "bonus", "bonus-row", "bonus")}${CATEGORIES.slice(6).map((category, index) => row(category, index === 0)).join("")}${computed(t("game.columnTotal"), "total", "column-total")}${general}</tbody></table></div>`;
}

function turnNoticeMarkup() {
  if (!ui.turnNotice) return "";
  const notice = ui.turnNotice;
  const message = t(notice.entry.kind === "sacrifice" ? "turnNotice.sacrifice" : "turnNotice.score", {
    name: notice.playerName, category: categoryText(notice.categoryId, "notice"),
    column: gameFormat(notice.format) === "classic" ? t(`turnNotice.columns.${notice.columnId}`) : "",
    score: notice.entry.score, points: tp("turnNotice.points", notice.entry.score),
  });
  return `<div class="turn-notice" role="status" style="--turn-notice-duration:${TURN_NOTICE_DURATION_MS}ms"><strong>${escapeHtml(message)}</strong>${notice.nextName ? `<small>${t("turnNotice.next", { name: escapeHtml(notice.nextName) })}</small>` : ""}</div>`;
}

function renderGame() {
  if (!ui.observation && !data.activeGame) { ui.screen = "home"; return shell(renderHome(), { compact: true }); }
  const { game, players } = materializedGame();
  const activeIndex = activePlayerIndex(players.length, game.timeline.cursor);
  const active = players[activeIndex];
  const observer = ui.observation;
  const shownIndex = observer && matchMedia("(max-width: 650px)").matches && observer.selected !== "turn" ? Math.max(0, players.findIndex(p => p.id === observer.selected)) : activeIndex;
  const connected = [...managerPeers].filter(peer => peer.live).length;
  const toolbar = observer ? `<button class="toolbar-button" data-action="rules" aria-label="${t("common.rules")}">? <span>${t("common.rules")}</span></button><button class="toolbar-button" data-action="observer-options" aria-label="${t("v3.options")}">⋯ <span>${t("v3.options")}</span></button><button class="toolbar-button" data-action="quit-game" aria-label="${t("v3.leave")}">⌂ <span>${t("v3.leave")}</span></button>` : `<button class="toolbar-button" data-action="add-observer" aria-label="${t("v3.addObserver")}" title="${t("v3.addObserver")}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><span>${t("v3.addObserver")}</span>${connected ? `<small>${connected}</small>` : ""}</button><button class="toolbar-button" data-action="game-options" aria-label="${t("v3.options")}" title="${t("v3.options")}">⋯ <span>${t("v3.options")}</span></button><button class="toolbar-button" data-action="roll-helper" aria-label="${t("game.analyze")}"><b class="toolbar-symbol">⚄</b><span>${t("game.analyze")}</span></button><button class="toolbar-button" data-action="undo" aria-label="${t("game.undo")}" ${game.timeline.cursor === 0 ? "disabled" : ""}>↶ <span>${t("game.undo")}</span></button><button class="toolbar-button" data-action="redo" aria-label="${t("game.redo")}" ${game.timeline.cursor === game.timeline.events.length ? "disabled" : ""}>↷ <span>${t("game.redo")}</span></button><button class="toolbar-button" data-action="rules" aria-label="${t("common.rules")}">? <span>${t("common.rules")}</span></button><button class="toolbar-button" data-action="quit-game" aria-label="${t("game.quit")}">⌂ <span>${t("game.quit")}</span></button>`;
  return `<div class="game-shell ${observer ? "observer-shell" : ""} ${ui.turnNotice ? "turn-changing" : ""}"><header class="game-toolbar"><button class="brand" data-action="quit-game" aria-label="${t("common.home")}"><span class="mini-die">⚄</span><span>Yam’s</span></button><div class="turn-identity"><small>${t("game.turn")}</small><strong>${escapeHtml(active.name)}</strong><span>${t("game.entry", { count: game.timeline.cursor + 1 })}</span></div><div class="game-actions">${toolbar}</div></header><main class="game-main"><div class="turn-mobile"><small>${t("game.turn")}</small><strong>${escapeHtml(active.name)}</strong></div><p class="format-badge">${t(`v3.formats.${gameFormat(game)}`)}${observer ? ` · ${t("v3.observing")}` : ""}</p>${observer ? `<div class="observer-status ${observer.live ? "" : "is-offline"}" role="status">${t(observer.live ? "v3.live" : "v3.disconnected")}${!observer.live ? `<button class="button quiet" data-action="rejoin-game">${t("v3.rejoin")}</button>` : ""}</div><label class="observer-select">${t("v3.following")}<select data-observer-player><option value="turn" ${observer.selected === "turn" ? "selected" : ""}>${t("v3.followTurn")}</option>${players.map(p=>`<option value="${escapeHtml(p.id)}" ${observer.selected === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></label>` : ""}${renderGameTable(players, shownIndex, activeIndex)}<p class="game-hint">${t(observer ? "v3.observerHint" : "game.hint")}</p></main>${turnNoticeMarkup()}${renderModal()}</div>`;
}

function rulesBody() {
  return `<section class="rules-intro"><h2>${t("rules.playTitle")}</h2><p>${t("rules.play")}</p></section><section class="rules-grid">${CATEGORIES.map((category) => `<article class="rule-card"><div><h3>${categoryText(category.id, "label")}</h3>${category.fixed ? `<span>${t("rules.fixed", { score: category.fixed })}</span>` : ""}</div><p>${categoryText(category.id, "help")}</p></article>`).join("")}</section><section class="rules-intro"><h2>${t("rules.bonusTitle")}</h2><p>${t("rules.bonus")}</p></section>`;
}

function renderRules() { return `<main class="content-page"><p class="eyebrow">${t("rules.eyebrow")}</p><h1>${t("rules.title")}</h1><p class="lead">${escapeHtml(ui.tagline)}</p>${rulesBody()}</main>`; }

function recordCard(label, record, key) {
  return `<article class="record-card"><span>${label}</span>${record ? `<strong>${record[key]}</strong><p>${escapeHtml(record.name)} · ${formatDate(record.date)}</p>` : `<strong>—</strong><p>${t("stats.noCompleted")}</p>`}</article>`;
}

function renderStatistics() {
  const stats = buildStatistics(data.pastGames, data.profiles, data.activeGame, ui.statsFormat);
  return `<main class="content-page stats-page"><p class="eyebrow">${t("stats.eyebrow")}</p><h1>${t("stats.title")}</h1>${formatPicker(ui.statsFormat, "data-stats-format")}<section class="stat-counts"><article><strong>${stats.counts.started}</strong><span>${tp("stats.started", stats.counts.started)}</span></article><article><strong>${stats.counts.completed}</strong><span>${tp("stats.completed", stats.counts.completed)}</span></article><article><strong>${stats.counts.abandoned}</strong><span>${tp("stats.abandoned", stats.counts.abandoned)}</span></article></section><h2>${t("stats.records")}</h2><section class="records-grid">${recordCard(t("stats.highTotal"), stats.records.highestGeneral, "general")}${ui.statsFormat !== "disorder" ? recordCard(t("stats.highOrder"), stats.records.highestOrder, "order") : ""}${ui.statsFormat !== "order" ? recordCard(t("stats.highDisorder"), stats.records.highestDisorder, "disorder") : ""}${recordCard(t("stats.lowTotal"), stats.records.lowestGeneral, "general")}</section><h2>${t("stats.top")}</h2><section class="ranking-list">${stats.topTen.length ? stats.topTen.map((entry, index) => `<article><span class="rank">${index + 1}</span><div><strong>${escapeHtml(entry.name)}</strong><small>${formatDate(entry.date)}</small></div><b>${entry.general}</b></article>`).join("") : `<p class="empty-state">${t("stats.topEmpty")}</p>`}</section><h2>${t("stats.savedPlayers")}</h2><section class="ranking-list">${stats.playerRanking.length ? stats.playerRanking.map((entry, index) => `<article><span class="rank">${index + 1}</span><div><strong>${escapeHtml(entry.profile.name)}</strong><small>${tp("stats.games", entry.games)} · ${tp("stats.wins", entry.wins)}</small></div><b>${entry.best}</b></article>`).join("") : `<p class="empty-state">${t("stats.playersEmpty")}</p>`}</section></main>`;
}

function renderResults() {
  const completed = ui.completed;
  if (!completed) return `<main class="content-page"><h1>${t("results.none")}</h1></main>`;
  const { record, badges } = completed;
  const early = record.status === "abandoned";
  const columns = columnsForFormat(record);
  return `<main class="results-page"><p class="eyebrow">${t(early ? "v3.interrupted" : "results.eyebrow")}</p><h1>${t(early ? "v3.provisional" : "results.title")}</h1><p class="format-badge">${t(`v3.formats.${gameFormat(record)}`)}</p><p class="lead">${early ? t("v3.earlyHelp") : escapeHtml(ui.tagline)}</p>${ui.observation ? `<p class="saved-note">${t("v3.finalObserver")}</p>` : ""}${early ? `<section class="bonus-policy">${columns.map((column) => `<p>${columnLabel(column)} : ${t(record.bonusIncluded[column] ? "v3.bonusIncluded" : "v3.bonusExcluded")}</p>`).join("")}</section>${record.unequalTurns ? `<p class="constraint-warning" role="status">${t("v3.unequalTurns")}</p>` : ""}` : ""}<section class="final-ranking">${record.results.map((result, index) => `<article class="final-result rank-${result.rank}" style="--delay:${index * 90}ms"><span class="podium-rank">${result.rank}</span><div class="result-player"><strong>${escapeHtml(result.name)}</strong><small>${columns.map((column) => `${columnLabel(column)} ${result[column]}`).join(" · ")}</small>${early ? `<small>${t("v3.turns", { count: result.turns })}</small>${columns.map((column) => `<small class="bonus-state ${result.bonuses[column]}">${columnLabel(column)} · ${t(`v3.bonus.${result.bonuses[column]}`)}</small>`).join("")}` : ""}${badges.filter((badge) => badge.playerId === result.playerId).map((badge) => `<em>✦ ${t(`results.records.${badge.type}`)}</em>`).join("")}</div><b>${result.general}</b></article>`).join("")}</section><div class="results-actions"><button class="button primary large" data-action="home">${t("results.home")}</button>${ui.observation ? "" : `<button class="button secondary large" data-action="stats">${t("results.stats")}</button>`}${early || ui.observation ? "" : `<button class="button quiet large full-span" data-action="correct-last">↶ ${t("results.correct")}</button>`}</div></main>`;
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
  const suggestions = analyzeRoll(active, ui.dice, game);
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
  if (ui.modal.type === "share") return pairingModal();
  if (ui.modal.type === "observer-options") return dialogFrame(`<h2>${t("v3.options")}</h2><label class="check-label"><input type="checkbox" data-keep-awake ${data.settings.keepAwake ? "checked" : ""}/> ${t("v3.keepAwake")}</label><p class="dialog-help">${t("v3.wakeHelp")}</p>${lastDiagnosticControls()}<button class="button quiet full" data-action="quit-game">${t("v3.leave")}</button>`, t("v3.options"));
  if (ui.modal.type === "options") return dialogFrame(`<h2>${t("v3.options")}</h2><label class="check-label"><input type="checkbox" data-keep-awake ${data.settings.keepAwake ? "checked" : ""}/> ${t("v3.keepAwake")}</label><p class="dialog-help">${t("v3.wakeHelp")}</p>${lastDiagnosticControls()}<div class="dialog-actions"><button class="button danger-outline" data-action="finish-early">${t("v3.finish")}</button></div>`, t("v3.options"));
  if (ui.modal.type === "finish") return dialogFrame(`<h2>${t("v3.finishQuestion")}</h2><p class="dialog-help">${t("v3.finishHelp")}</p><div class="dialog-actions"><button class="button quiet" data-action="close-modal">${t("common.cancel")}</button><button class="button danger" data-action="confirm-finish">${t("v3.finish")}</button></div>`, t("v3.finish"));
  if (ui.modal.type === "score") return scoreModal(ui.modal);
  if (ui.modal.type === "roll") return rollHelperModal();
  if (ui.modal.type === "roll-confirm") return rollConfirmModal(ui.modal);
  if (ui.modal.type === "abandon") return dialogFrame(`<p class="eyebrow">${t("abandon.eyebrow")}</p><h2>${t("abandon.title")}</h2><p class="dialog-help">${t("abandon.help")}</p><div class="dialog-actions"><button class="button quiet" data-action="close-modal">${t("abandon.keep")}</button><button class="button danger" data-action="confirm-abandon">${t("abandon.confirm")}</button></div>`, t("abandon.dialog"));
  if (ui.modal.type === "category") { const category = categoryById(ui.modal.categoryId); return dialogFrame(`<p class="eyebrow">${t("common.rules")}</p><h2>${categoryText(category.id, "label")}</h2><p class="dialog-help rule-detail">${categoryText(category.id, "help")}</p>${category.fixed ? `<p class="fixed-score-callout">${t("rules.fixed", { score: category.fixed })}</p>` : ""}`, categoryText(category.id, "label")); }
  if (ui.modal.type === "computed") { const bonus = ui.modal.ruleId === "bonus"; return dialogFrame(`<p class="eyebrow">${t("common.rules")}</p><h2>${t(bonus ? "game.bonus" : "rules.upperTitle")}</h2><p class="dialog-help rule-detail">${t(bonus ? "rules.bonusDetail" : "rules.upperDetail")}</p>`, t(bonus ? "game.bonus" : "rules.upperTitle")); }
  return "";
}

function beginSetup() {
  ui.format = "classic"; ui.playerCount = 4; ui.setupPlayers = []; ui.setupIndex = 0;
  navigate("setup-count");
}

async function startGame() {
  const usedAt = new Date().toISOString();
  const selectedPlayers = ui.setupPlayers.map(selectedSetupPlayer);
  const basePlayers = selectedPlayers.map((player) => ({ id: id("player"), name: player.name.trim(), profileId: player.profileId || (player.remember ? player.id : null) }));
  data.profiles = updateRememberedProfiles(data.profiles, selectedPlayers, usedAt);
  data.activeGame = { id: id("game"), status: "active", format: ui.format, createdAt: usedAt, basePlayers, timeline: { events: [], cursor: 0 } };
  await persist();
  requestPersistentStorage();
  navigate("game", { replace: true });
}

async function advancePlayerSetup() {
  const player = selectedSetupPlayer(ui.setupPlayers[ui.setupIndex]);
  if (!player.name.trim()) { ui.error = t("setup.missingName"); render(); return; }
  ui.error = "";
  if (ui.setupIndex === ui.playerCount - 1) await startGame();
  else { ui.setupIndex += 1; render(); }
}

async function commitEntry(entry) {
  if (ui.observation || scoringBusy) return;
  const modal = ui.modal;
  if (!modal || !["score", "roll-confirm"].includes(modal.type)) return;
  const { game, players } = materializedGame();
  const activeIndex = activePlayerIndex(players.length, game.timeline.cursor);
  const player = players[activeIndex];
  const playerIndex = modal.type === "score" ? modal.playerIndex : activeIndex;
  if (playerIndex !== activeIndex || !columnsForFormat(game).includes(modal.columnId) || !isCellPlayable(player, modal.columnId, modal.categoryId)) return;
  if (entry.kind === "score" && !validateScore(modal.categoryId, entry.score, player.columns[modal.columnId])) return;
  scoringBusy = true;
  try {
  clearTurnNotice();
  const previousStats = buildStatistics(data.pastGames, data.profiles, null, game);
  game.timeline = appendTimelineEvent(game.timeline, { id: id("event"), playerId: player.id, columnId: modal.columnId, categoryId: modal.categoryId, entry, createdAt: new Date().toISOString() });
  data.activeGame = game;
  ui.modal = null;
  history.replaceState(historyState(), "");
  const updatedPlayers = materializePlayers(game.basePlayers, game.timeline);
  if (isGameComplete(updatedPlayers, game)) {
    const record = completedGameRecord(game, updatedPlayers, new Date().toISOString());
    const badges = newRecordBadges(previousStats, record.results);
    ui.turnNotice = { playerName: player.name, nextName: null, format: gameFormat(game), columnId: modal.columnId, categoryId: modal.categoryId, entry };
    data.pastGames.push(record); data.activeGame = null; ui.completed = { record, badges }; ui.statsFormat = gameFormat(game); ui.screen = "results"; refreshTagline("results"); history.replaceState(historyState(), "");
  } else {
    const nextIndex = activePlayerIndex(updatedPlayers.length, game.timeline.cursor);
    ui.turnNotice = { playerName: player.name, nextName: updatedPlayers[nextIndex].name, format: gameFormat(game), columnId: modal.columnId, categoryId: modal.categoryId, entry };
  }
  await persist();
  publishGame(ui.turnNotice ? id("notice") : null);
  render();
  if (ui.turnNotice) { clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { ui.turnNotice = null; noticeTimer = null; if (["game", "results"].includes(ui.screen)) render(); }, TURN_NOTICE_DURATION_MS); }
  } finally { scoringBusy = false; }
}

async function finishEarly() {
  if (ui.observation || scoringBusy || !data.activeGame || ui.modal?.type !== "finish") return;
  scoringBusy = true;
  try {
  clearTurnNotice();
  const { game, players } = materializedGame();
  const record = interruptedGameRecord(game, players, new Date().toISOString());
  data.pastGames.push(record); data.activeGame = null;
  ui.completed = { record, badges: [] }; ui.statsFormat = gameFormat(record);
  await persist(); publishGame(); navigate("results", { replace: true });
  } finally { scoringBusy = false; }
}

async function moveHistory(direction) {
  if (ui.observation || !data.activeGame || scoringBusy) return;
  scoringBusy = true;
  try {
  clearTurnNotice();
  data.activeGame.timeline = direction === "undo" ? undoTimeline(data.activeGame.timeline) : redoTimeline(data.activeGame.timeline);
  const { game, players } = materializedGame();
  if (isGameComplete(players, game)) {
    const previous = buildStatistics(data.pastGames, data.profiles, null, game);
    const record = completedGameRecord(game, players, new Date().toISOString());
    ui.completed = { record, badges: newRecordBadges(previous, record.results) };
    data.pastGames.push(record); data.activeGame = null;
    ui.screen = "results"; refreshTagline("results"); history.replaceState(historyState(), "");
  }
  await persist(); publishGame(); render();
  } finally { scoringBusy = false; }
}

window.addEventListener("popstate", (event) => {
  if (!event.state?.yams) return;
  const previousScreen = ui.screen;
  const target = event.state;
  const hadModal = Boolean(ui.modal);
  if (hadModal) { if (ui.modal.type === "share") cancelPairing(); ui.modal = null; }
  if (previousScreen === "game" && !hadModal) {
    clearTurnNotice(); leaveSharing();
    if (target.depth > 0) { history.go(-target.depth); return; }
    ui.screen = "home"; navDepth = 0; refreshTagline("home");
  } else {
    ui.screen = target.screen; navDepth = target.depth ?? 0;
    if (["home", "rules", "results"].includes(ui.screen)) refreshTagline(ui.screen);
  }
  if (ui.screen === "home") leaveSharing();
  if (ui.screen === "game" && !ui.observation && !data.activeGame) ui.screen = ui.completed ? "results" : "home";
  render();
});

app.addEventListener("click", async (event) => {
  const mail=event.target.closest('[data-debug-mail]');
  if(mail && DIAGNOSTICS_ENABLED && diagnosticTools && ui.lastDiagnostic) {
    if(diagnosticRecipientEditing){event.preventDefault();return;}
    // Refresh synchronously before native mail navigation: never send an old poll.
    mail.href=diagnosticTools.diagnosticExport(ui.lastDiagnostic).mailto;
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (scoringBusy) return;
  if (ui.observation && ["game-options","finish-early","confirm-finish","correct-last","undo","redo","open-score","commit-score","sacrifice","roll-helper","confirm-suggestion","new-game","resume","stats","add-observer"].includes(action)) return;
  if (action === "add-observer" || action === "add-another") await beginAdding();
  else if (action === "join-game") beginJoining();
  else if (action === "rejoin-game") { leaveSharing(); ui.screen = "home"; beginJoining(); }
  else if (action === "pair-next") { ui.pairing.step = "scan-answer"; ui.pairing.error = ""; render(); }
  else if (action === "debug-clear-recipient" && DIAGNOSTICS_ENABLED) {
    const tools=await loadDiagnosticTools();tools.setDiagnosticRecipient('');
    diagnosticRecipientEditing=false;diagnosticRecipientMessage='recipientCleared';
    diagnosticUpload={status:'idle',key:null,reportId:null};updateDiagnosticControls();
  }
  else if (action === "debug-send" && DIAGNOSTICS_ENABLED) await uploadDiagnostic();
  else if (action === "debug-share" && DIAGNOSTICS_ENABLED) await shareDiagnostic();
  else if (action === "debug-self-test" && DIAGNOSTICS_ENABLED) await testThisDevice();
  else if (action === "pair-copy" && DIAGNOSTICS_ENABLED) {
    try {await navigator.clipboard.writeText(JSON.stringify(ui.pairing.diagnostics,null,2));button.textContent=t('v3.copied');}
    catch {const block=document.querySelector('[data-pair-diagnostics]');if(block){const range=document.createRange();range.selectNodeContents(block);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}}
  }
  else if (action === "pair-retry") { const manager = ui.pairing?.role === "manager"; cancelPairing(); if (manager) await beginAdding(); else beginJoining(); }
  else if (action === "observer-options") openModal({ type: "observer-options" });
  else if (action === "game-options") openModal({ type: "options" });
  else if (action === "finish-early") replaceModal({ type: "finish" });
  else if (action === "confirm-finish") await finishEarly();
  else if (action === "home") returnHome();
  else if (action === "back") history.back();
  else if (action === "resume") navigate("game");
  else if (action === "new-game") data.activeGame ? openModal({ type: "abandon" }) : beginSetup();
  else if (action === "confirm-abandon") { data = archiveActiveGame(data, "abandoned", new Date().toISOString()); await persist(); ui.modal = null; history.replaceState(historyState(), ""); beginSetup(); }
  else if (action === "set-count") { ui.playerCount = Number(button.dataset.count); render(); }
  else if (action === "continue-setup") { const firstProfile = sortProfilesByRecentUse(data.profiles)[0]; ui.setupPlayers = Array.from({ length: ui.playerCount }, () => ({ id: id("profile"), profileId: firstProfile?.id ?? null, newPlayer: !firstProfile, name: "", remember: false })); ui.setupIndex = 0; navigate("setup-players"); }
  else if (action === "previous-player") { ui.setupIndex = Math.max(0, ui.setupIndex - 1); ui.error = ""; render(); }
  else if (action === "rules") navigate("rules");
  else if (action === "stats") navigate("stats");
  else if (action === "correct-last" && ui.completed?.record.status === "completed") { const record = ui.completed.record; data.pastGames = data.pastGames.filter((game) => game.id !== record.id); data.activeGame = { ...record, status: "active", endedAt: undefined, results: undefined, timeline: undoTimeline(record.timeline) }; ui.completed = null; await persist(); publishGame(); navigate("game", { replace: true }); }
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
  if (event.target.matches("[data-observer-player]") && ui.observation) { ui.observation.selected = event.target.value; render(); return; }
  if (event.target.matches("[data-format]")) { ui.format = gameFormat(event.target.value); render(); return; }
  if (event.target.matches("[data-stats-format]")) { ui.statsFormat = gameFormat(event.target.value); render(); return; }
  if (event.target.matches("[data-keep-awake]")) { data.settings.keepAwake = event.target.checked; await persist(); updateWakeLock(); return; }
  if (event.target.matches("[data-language]")) { data.settings.locale = setLocale(event.target.value); refreshTagline("home"); await persist(); render(); return; }
  const profileIndex = event.target.dataset.setupProfile;
  const rememberIndex = event.target.dataset.setupRemember;
  const newIndex = event.target.dataset.setupNew;
  if (newIndex !== undefined) {
    const player = ui.setupPlayers[Number(newIndex)];
    player.newPlayer = !availableSetupProfiles(Number(newIndex)).length || event.target.checked;
    ui.error = ""; render();
    requestAnimationFrame(() => document.querySelector(player.newPlayer ? "[data-setup-name]" : "[data-setup-profile]")?.focus());
  } else if (profileIndex !== undefined) {
    const player = ui.setupPlayers[Number(profileIndex)];
    if (player.newPlayer) return;
    const profile = availableSetupProfiles(Number(profileIndex)).find((item) => item.id === event.target.value);
    if (profile) player.profileId = profile.id;
    ui.error = ""; render();
  } else if (rememberIndex !== undefined) {
    const player = ui.setupPlayers[Number(rememberIndex)];
    if (player.newPlayer) player.remember = event.target.checked;
  }
});

app.addEventListener("input", (event) => {
  if(DIAGNOSTICS_ENABLED && event.target.matches('[data-diagnostic-recipient]')) {
    diagnosticRecipientEditing=true;diagnosticRecipientDraft=event.target.value;diagnosticRecipientMessage='recipientUnsaved';
    document.querySelectorAll('[data-action=debug-send]').forEach(button=>{button.disabled=true;});
    document.querySelectorAll('[data-recipient-status]').forEach(node=>{node.textContent=t('v3.recipientUnsaved');});
  }
  const index = event.target.dataset.setupName;
  if (index !== undefined && ui.setupPlayers[Number(index)].newPlayer) ui.setupPlayers[Number(index)].name = event.target.value;
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if(DIAGNOSTICS_ENABLED && event.target.matches('[data-debug-recipient-form]')) {
    const tools=await loadDiagnosticTools();
    try {tools.setDiagnosticRecipient(new FormData(event.target).get('recipient'));diagnosticRecipientMessage='recipientSaved';diagnosticRecipientEditing=false;diagnosticUpload={status:'idle',key:null,reportId:null};}
    catch {diagnosticRecipientMessage='recipientInvalid';}
    updateDiagnosticControls();return;
  }
  if (ui.observation) return;
  if (event.target.id === "player-form") await advancePlayerSetup();
  if (event.target.id === "variable-score-form") await commitEntry(scoreEntry(Number(new FormData(event.target).get("score") ?? document.querySelector("#variable-score")?.value)));
});

function publishGame(noticeId = null) { for (const peer of managerPeers) peer.publish(noticeId); }

function cancelPairing() {
  stopScanner?.(); stopScanner = null;
  const peer = ui.pairing?.peer;
  ui.pairing = null;
  if (peer && !peer.ready) {
    managerPeers.delete(peer);
    if (observerPeer === peer) observerPeer = null;
    peer.close();
  }
}

function leaveSharing() {
  cancelPairing();
  if (ui.observation || observerPeer) {
    const peer = observerPeer; observerPeer = null;
    ui.observation = null; ui.completed = null; peer?.leave();
  }
  for (const peer of managerPeers) {
    // A final result already delivered remains on each observer's screen.
    if (data.activeGame) peer.exit(); else peer.finish();
  }
  managerPeers.clear();
}

function pairError(pair, code) {
  if (ui.pairing !== pair) return;
  pair.step = 'error'; pair.error = ['unsupported','connectionFailed'].includes(code) ? code : 'pairError';
  if(!pair.peer?.ready)pair.peer?.close();
  render();
}

function updatePairDiagnostics(pair, details) {
  if(!DIAGNOSTICS_ENABLED || ui.pairing!==pair)return;
  pair.diagnostics=details;
  ui.lastDiagnostic=internalTest.result?{...details,selfTest:internalTest.result}:details;
  // Local module only; loading it never submits a report or opens another app.
  if(!diagnosticToolsPromise)void loadDiagnosticTools().catch(()=>{});
  const block=document.querySelector('[data-pair-diagnostics]');
  if(block)block.textContent=JSON.stringify(details,null,2);
}

function internalTestControls() {
  if(!DIAGNOSTICS_ENABLED)return '';
  const label=internalTest.status==='running'?'internalTestRunning':'internalTest';
  const result=internalTest.status==='passed'?'internalTestPassed':internalTest.status==='failed'?'internalTestFailed':null;
  return `<div class="internal-test"><button class="button quiet" data-action="debug-self-test" ${internalTest.status==='running'?'disabled':''}>${t('v3.'+label)}</button><p>${t('v3.internalTestHelp')}</p><p role="status">${result?t('v3.'+result):''}</p></div>`;
}

function updateInternalTestControls() {
  document.querySelectorAll('[data-internal-test-controls]').forEach(block=>{block.innerHTML=internalTestControls();});
  document.querySelectorAll('[data-debug-last]').forEach(block=>{block.innerHTML=lastDiagnosticControls();});
}

async function testThisDevice() {
  if(!DIAGNOSTICS_ENABLED||internalTest.status==='running')return;
  internalTest={status:'running',result:null};updateInternalTestControls();
  let result,env=null;
  try {
    const tools=await import('./peer-diagnostics.js');
    [result,env]=await Promise.all([tools.runLocalPeerTest(createPeer),tools.readEnvironment()]);
  } catch {result={result:'failed',failure:'setup',durationMs:null,manager:null,observer:null};}
  result.completedAt=Date.now();internalTest={status:result.result,result};
  ui.lastDiagnostic=ui.lastDiagnostic?{...ui.lastDiagnostic,selfTest:result}:{version:BUILD_NUMBER,kind:'local-test',role:'device',ready:result.result==='passed',environment:env,selfTest:result};
  void loadDiagnosticTools().catch(()=>{});updateInternalTestControls();updateDiagnosticControls();
}

function diagnosticKey(details) { return `${details?.attemptId ?? 'pending'}:${details?.role ?? ''}:${details?.failure ?? ''}:${!!details?.ready}`; }

function diagnosticUploadControls() {
  if(!DIAGNOSTICS_ENABLED || !ui.lastDiagnostic)return '';
  const recipient=diagnosticTools?.getDiagnosticRecipient() ?? '';
  const recipientControls=`<form class="diagnostic-recipient" data-debug-recipient-form><label>${t('v3.recipientLabel')}<input type="email" name="recipient" data-diagnostic-recipient maxlength="254" autocomplete="off" value="${escapeHtml(diagnosticRecipientEditing?diagnosticRecipientDraft:recipient)}" required /></label><div class="diagnostic-fallback-actions"><button class="button quiet" type="submit">${t('v3.recipientSave')}</button><button class="button quiet" type="button" data-action="debug-clear-recipient" ${recipient?'':'disabled'}>${t('v3.recipientClear')}</button></div><p>${t('v3.recipientHelp')}</p><p data-recipient-status role="status">${diagnosticRecipientMessage?t('v3.'+diagnosticRecipientMessage):recipient?'':t('v3.recipientRequired')}</p></form>`;
  const status=diagnosticUpload.key===diagnosticKey(ui.lastDiagnostic) ? diagnosticUpload.status : 'idle';
  const failureKey=diagnosticUpload.reason==='recipient'?'recipientRequired':diagnosticUpload.reason==='offline'?'diagnosticOffline':diagnosticUpload.reason==='rejected'?'diagnosticRejected':'diagnosticSendError';
  const exported=diagnosticTools?.diagnosticExport(ui.lastDiagnostic);
  return `${recipientControls}<button class="button quiet" data-action="debug-send" ${diagnosticUpload.status==='sending'||!recipient||diagnosticRecipientEditing?'disabled':''}>${t(status==='sending'?'v3.sendingDiagnostic':'v3.sendDiagnostic')}</button><p class="debug-send-status" role="status">${status==='sent'?escapeHtml(t('v3.diagnosticSent',{id:diagnosticUpload.reportId.slice(0,8)})):status==='error'?t('v3.'+failureKey):''}</p>${exported?`<div class="diagnostic-fallback"><p>${t('v3.diagnosticFallbackHelp')}</p><div class="diagnostic-fallback-actions"><a class="button quiet" data-debug-mail href="${escapeHtml(exported.mailto)}">${t('v3.diagnosticMail')}</a><button class="button quiet" data-action="debug-share">${t('v3.diagnosticShare')}</button></div><p role="status">${diagnosticShare?.key===diagnosticKey(ui.lastDiagnostic)?t('v3.'+diagnosticShare.message):''}</p></div>`:''}`;
}

function updateDiagnosticControls() {
  document.querySelectorAll('[data-debug-upload-controls]').forEach(block=>{block.innerHTML=diagnosticUploadControls();});
}

function loadDiagnosticTools() {
  if(!DIAGNOSTICS_ENABLED)return Promise.reject(Error('diagnostics-disabled'));
  if(!diagnosticToolsPromise)diagnosticToolsPromise=import('./debug-reporting.js').then(module=>{diagnosticTools=module;updateDiagnosticControls();return module;}).catch(error=>{diagnosticToolsPromise=null;throw error;});
  return diagnosticToolsPromise;
}

async function shareDiagnostic() {
  if(!DIAGNOSTICS_ENABLED || !ui.lastDiagnostic)return;
  const details=ui.lastDiagnostic,key=diagnosticKey(details);
  const tools=await loadDiagnosticTools();
  const exported=tools.diagnosticExport(details);
  const file=new File([exported.text],exported.fileName,{type:'application/json'});
  try {
    if(navigator.canShare?.({files:[file]})) {
      await navigator.share({files:[file],title:`Yam’s · v${BUILD_NUMBER}`});
      diagnosticShare={key,message:'diagnosticShared'};
    } else {
      const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=exported.fileName;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);
      diagnosticShare={key,message:'diagnosticDownloaded'};
    }
  } catch(error) {
    if(error.name!=='AbortError')diagnosticShare={key,message:'diagnosticShareError'};
  }
  updateDiagnosticControls();
}

function lastDiagnosticControls() {
  return DIAGNOSTICS_ENABLED && ui.lastDiagnostic ? `<details class="last-diagnostic"><summary>${t('v3.lastDiagnostic')}</summary><p>${t('v3.sendDiagnosticHelp')}</p><div data-debug-upload-controls>${diagnosticUploadControls()}</div></details>` : '';
}

async function uploadDiagnostic() {
  if(!DIAGNOSTICS_ENABLED || !ui.lastDiagnostic || diagnosticUpload.status==='sending' || diagnosticRecipientEditing)return;
  const details=ui.lastDiagnostic,key=diagnosticKey(details);
  // A retry of an ambiguous timeout reuses its public report ID for deduplication.
  const reportId=diagnosticUpload.key===key && diagnosticUpload.status==='error' ? diagnosticUpload.reportId : crypto.randomUUID();
  diagnosticUpload={status:'sending',key,reportId};
  updateDiagnosticControls();
  try {
    const {sendDiagnostic}=await loadDiagnosticTools();
    await sendDiagnostic(details,{reportId});
    diagnosticUpload={status:'sent',key,reportId};
  } catch(error) {diagnosticUpload={status:'error',key,reportId,reason:error.code??'network'};}
  updateDiagnosticControls(); // Never rerender the camera, QR or game when an upload settles.
}

async function beginAdding() {
  if (!data.activeGame || ui.observation) return;
  cancelPairing();
  const pair = { role: 'manager', step: 'preparing', qr: '', error: '', peer: null };
  ui.pairing = pair;
  if (ui.modal?.type === 'share') replaceModal({type:'share'}); else openModal({type:'share'});
  try {
    const peer = createPeer('manager', {
      getState: () => data.activeGame ?? ui.completed?.record,
      onReady: () => { if (ui.pairing === pair) {pair.step='added';render();} },
      onStatus: () => { if (ui.screen === 'game' && ui.modal?.type !== 'share') render(); },
      onLeave: () => { managerPeers.delete(peer); if(ui.screen==='game' && ui.modal?.type !== 'share')render(); },
      onError: code => pairError(pair,code),
      onDiagnostics: details => updatePairDiagnostics(pair,details),
    });
    pair.peer = peer; managerPeers.add(peer);
    const qr = await peer.offer();
    if (ui.pairing !== pair) return;
    pair.qr=qr; pair.step='offer'; render();
  } catch(error) { pairError(pair,error.message); }
}

function beginJoining() {
  cancelPairing(); ui.banner='';
  ui.pairing = { role:'observer',step:'scan-offer',qr:'',error:'',peer:null };
  if(ui.modal?.type==='share')replaceModal({type:'share'});else openModal({type:'share'});
}

function receiveObservedGame(game, noticeId) {
  const first = !ui.observation;
  if (first) ui.observation = {game, selected:'turn', live:true, lastNotice:null};
  const observed=ui.observation;
  observed.game=game; observed.live=true;
  if (noticeId && noticeId !== observed.lastNotice) {
    observed.lastNotice=noticeId;
    const event=game.timeline.events[game.timeline.cursor-1];
    if(event) {
      const player=game.basePlayers.find(p=>p.id===event.playerId);
      const next=game.basePlayers[activePlayerIndex(game.basePlayers.length,game.timeline.cursor)];
      clearTurnNotice();
      ui.turnNotice={playerName:player.name,nextName:game.status === "active" ? next.name : null,format:gameFormat(game),columnId:event.columnId,categoryId:event.categoryId,entry:event.entry};
      noticeTimer=setTimeout(()=>{ui.turnNotice=null;noticeTimer=null;if(['game','results'].includes(ui.screen))render();},TURN_NOTICE_DURATION_MS);
    }
  }
  if (game.status !== 'active') {
    if (!noticeId) clearTurnNotice();
    const players=materializePlayers(game.basePlayers,game.timeline);
    const record=game.status==='completed' ? completedGameRecord(game,players,null) : interruptedGameRecord(game,players,null);
    ui.completed={record,badges:[]};
    ui.modal=null;ui.pairing=null;
    if (ui.screen !== 'results') navigate('results',{replace:true}); else render();
    return;
  }
  if(first || ui.screen==='results') {
    ui.completed=null;ui.modal=null;ui.pairing=null;navigate('game',{replace:true});
  } else render();
}

async function handlePairingCode(text, pair) {
  if(ui.pairing!==pair)return false;
  try {
    // Validate before dismissing the camera. An unrelated QR is never navigated to.
    if(pair.role==='observer')await decodeSignal(text,'offer');
    else await pair.peer.validateAnswer(text);
  } catch {
    const message=document.querySelector('[data-scan-message]');
    if(message)message.textContent=t('v3.invalidQr');
    return false;
  }
  stopScanner?.();stopScanner=null;pair.step='connecting';render();
  try {
    if(pair.role==='manager') {
      await pair.peer.acceptAnswer(text);
    } else {
      const peer=createPeer('observer',{
        onState:receiveObservedGame,
        onStatus: live=>{if(ui.observation && observerPeer===peer){ui.observation.live=live;render();}},
        onExit:()=>{
          if(ui.observation?.game.status==='active') {ui.banner=t('v3.sharedEnded');returnHome();}
        },
        onError:code=>pairError(pair,code),
        onDiagnostics:details=>updatePairDiagnostics(pair,details),
      });
      pair.peer=peer;observerPeer=peer;
      const qr=await peer.answer(text);
      if(ui.pairing===pair){pair.qr=qr;pair.step='answer';render();}
    }
  } catch(error) {pairError(pair,error.message);}
  return true;
}

function connectionPermissionHelp(pair) {
  // Browser permissions do not expose Android's permission for the host browser.
  // Keep this normal product help independent of debug modules and native probes.
  const opened=pair.step==='error' && ['connectionFailed','pairError'].includes(pair.error);
  return `<details class="pair-help" ${opened?'open':''}><summary>${t('v3.connectionHelp')}</summary><h3>${t('v3.androidPermissionTitle')}</h3><p>${t('v3.androidPermissionIntro')}</p><ol><li>${t('v3.androidSettingsStep')}</li><li>${t('v3.androidBrowserStep')}</li><li>${t('v3.androidAllowStep')}</li></ol><p>${t('v3.androidPermissionShortcut')}</p><p>${t('v3.androidPermissionMissing')}</p><p class="pair-help-note">${t('v3.androidPermissionUnknown')}</p><p>${t('v3.androidPermissionReturn')}</p></details>`;
}

function pairingModal() {
  const pair=ui.pairing;
  if(!pair)return '';
  let body='';
  if(pair.step==='offer' || pair.step==='answer') {
    body=`<p class="dialog-help">${t(pair.step==='offer'?'v3.offerHelp':'v3.answerHelp')}</p><div class="qr-frame"><canvas data-pair-qr role="img" aria-label="QR code"></canvas></div>${pair.step==='offer' ? `<p class="dialog-help">${t('v3.nextHelp')}</p><button class="button primary full" data-action="pair-next">${t('v3.next')}</button>` : `<p class="pair-status" role="status">${t('v3.waiting')}</p>`}`;
  } else if(pair.step.startsWith('scan-')) {
    body=`<h3>${t(pair.step==='scan-offer'?'v3.scanOffer':'v3.scanAnswer')}</h3><p class="dialog-help">${t('v3.scanHelp')}</p><div class="scanner-frame"><video data-qr-video autoplay playsinline muted></video><div class="scanner-guide" aria-hidden="true"></div></div><p class="scan-message" data-scan-message role="status"></p>`;
  } else if(pair.step==='added') {
    body=`<p class="pair-success" role="status">✓ ${t('v3.added')}</p><div class="dialog-actions"><button class="button primary" data-action="add-another">${t('v3.addAnother')}</button><button class="button secondary" data-action="close-modal">${t('v3.backGame')}</button></div>`;
  } else if(pair.step==='error') {
    body=`<p class="constraint-warning" role="alert">${t('v3.'+pair.error)}</p><button class="button primary full" data-action="pair-retry">${t('v3.retry')}</button>`;
  } else body=`<p class="pair-status" role="status">${t(pair.step==='preparing'?'v3.preparing':'v3.connecting')}</p>`;
  const diagnostics=DIAGNOSTICS_ENABLED && pair.diagnostics && !pair.step.startsWith('scan-') ? `<details class="pair-diagnostics" ${['connecting','error'].includes(pair.step)?'open':''}><summary>${t('v3.diagDetails')}</summary><button class="button quiet" data-action="pair-copy">${t('v3.copyDiagnostic')}</button><p>${t('v3.diagHelp')}</p><pre data-pair-diagnostics tabindex="0">${escapeHtml(JSON.stringify(pair.diagnostics,null,2))}</pre><p>${t('v3.sendDiagnosticHelp')}</p><div data-debug-upload-controls>${diagnosticUploadControls()}</div></details>` : '';
  return dialogFrame(`<h2>${t(pair.role==='manager'?'v3.addObserver':'v3.join')}${DIAGNOSTICS_ENABLED ? ` <small class="pair-version">v${PAIRING_BUILD}</small>` : ''}</h2>${body}${pair.step!=='added'?`<p class="pair-network">${t('v3.localHelp')}</p>${connectionPermissionHelp(pair)}`:''}${diagnostics}${pair.step!=='added'?`<button class="button quiet full" data-action="close-modal">${t('v3.cancel')}</button>`:''}`,t(pair.role==='manager'?'v3.addObserver':'v3.join'),'pair-modal');
}

function renderPairingMedia() {
  if(ui.modal?.type!=='share'||!ui.pairing)return;
  const pair=ui.pairing;
  const canvas=document.querySelector('[data-pair-qr]');
  if(canvas)drawQR(canvas,pair.qr).catch(()=>pairError(pair,'pairError'));
  const video=document.querySelector('[data-qr-video]');
  if(video)stopScanner=scanQR(video,text=>handlePairingCode(text,pair),()=>{
    if(ui.pairing===pair){pair.step='error';pair.error='scanError';render();}
  });
}

init();
