const DB_NAME = "yams-familial";
const DB_VERSION = 1;
const STORE_NAME = "state";
const ROOT_KEY = "application";

export const EMPTY_APP_DATA = Object.freeze({
  schemaVersion: 1,
  activeGame: null,
  profiles: [],
  pastGames: [],
  settings: { locale: null },
});

export function normalizeAppData(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: 1,
    activeGame: source.activeGame && typeof source.activeGame === "object" ? source.activeGame : null,
    profiles: Array.isArray(source.profiles) ? source.profiles : [],
    pastGames: Array.isArray(source.pastGames) ? source.pastGames : [],
    settings: {
      locale: typeof source.settings?.locale === "string" ? source.settings.locale : null,
    },
  };
}

export function sortProfilesByRecentUse(profiles) {
  return [...profiles].sort((a, b) => {
    const recent = String(b.lastUsedAt ?? "").localeCompare(String(a.lastUsedAt ?? ""));
    return recent || String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" });
  });
}

export function updateRememberedProfiles(profiles, selectedPlayers, usedAt) {
  const byId = new Map(profiles.map((profile) => [profile.id, { ...profile }]));
  for (const player of selectedPlayers) {
    if (!player.remember && !player.profileId) continue;
    const id = player.profileId ?? player.id;
    const existing = byId.get(id);
    byId.set(id, {
      id,
      name: player.name.trim(),
      createdAt: existing?.createdAt ?? usedAt,
      lastUsedAt: usedAt,
    });
  }
  return sortProfilesByRecentUse([...byId.values()]);
}

export function archiveActiveGame(data, status, endedAt) {
  if (!data.activeGame) return normalizeAppData(data);
  const archived = {
    ...structuredClone(data.activeGame),
    status,
    endedAt,
  };
  return {
    ...normalizeAppData(data),
    activeGame: null,
    pastGames: [...data.pastGames, archived],
  };
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

async function openDatabase() {
  if (!("indexedDB" in globalThis)) throw new Error("IndexedDB n’est pas disponible dans ce navigateur.");
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
  });
  return requestAsPromise(request);
}

export async function loadAppData() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = await requestAsPromise(transaction.objectStore(STORE_NAME).get(ROOT_KEY));
    await transactionDone(transaction);
    return normalizeAppData(value);
  } finally {
    database.close();
  }
}

export async function saveAppData(data) {
  const normalized = normalizeAppData(data);
  const database = await openDatabase();
  try {
    // Deux arguments seulement pour rester compatible avec Safari/iOS plus ancien.
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(structuredClone(normalized), ROOT_KEY);
    await transactionDone(transaction);
    return normalized;
  } finally {
    database.close();
  }
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
