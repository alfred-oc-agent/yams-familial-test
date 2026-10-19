import en from "./locales/en.js";
import fr from "./locales/fr.js";
import es from "./locales/es.js";
import de from "./locales/de.js";
import zhHans from "./locales/zh-Hans.js";
import ja from "./locales/ja.js";
import ar from "./locales/ar.js";

const PACKS = { en, fr, es, de, "zh-Hans": zhHans, ja, ar };
const LANGUAGE_NAMES = {
  fr: "Français", en: "English", es: "Español", de: "Deutsch",
  "zh-Hans": "简体中文", ja: "日本語", ar: "العربية",
};

let activeCode = "en";

function lookup(source, path) {
  return path.split(".").reduce((value, part) => value?.[part], source);
}

function interpolate(value, variables) {
  return String(value).replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? `{${key}}`);
}

export function normalizeLocale(locale) {
  const value = String(locale ?? "").toLowerCase();
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("zh")) return "zh-Hans";
  if (value.startsWith("ja")) return "ja";
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("en")) return "en";
  return null;
}

export function detectLocale(locales = globalThis.navigator?.languages ?? [globalThis.navigator?.language]) {
  for (const locale of locales.filter(Boolean)) {
    const supported = normalizeLocale(locale);
    if (supported) return supported;
  }
  return "en";
}

export function setLocale(locale) {
  activeCode = normalizeLocale(locale) ?? "en";
  document.documentElement.lang = activeCode;
  document.documentElement.dir = PACKS[activeCode].dir ?? "ltr";
  document.title = t("app.title");
  return activeCode;
}

export function localeCode() {
  return activeCode;
}

export function localeDirection() {
  return PACKS[activeCode].dir ?? "ltr";
}

export function localeOptions() {
  return Object.keys(PACKS).map((code) => ({ code, label: LANGUAGE_NAMES[code] }));
}

export function t(path, variables = {}) {
  const value = lookup(PACKS[activeCode], path) ?? lookup(en, path) ?? path;
  return interpolate(value, variables);
}

export function tp(path, count, variables = {}) {
  const rule = new Intl.PluralRules(activeCode).select(count);
  return t(`${path}.${rule === "one" ? "one" : "other"}`, { ...variables, count });
}

export function randomLine(path) {
  const lines = lookup(PACKS[activeCode], path) ?? lookup(en, path) ?? [];
  return lines[Math.floor(Math.random() * lines.length)] ?? "";
}

export function categoryText(categoryId, field) {
  return t(`categories.${categoryId}.${field}`);
}
