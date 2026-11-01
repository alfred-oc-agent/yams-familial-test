// Wake lock is opportunistic. OS refusal must never block scoring or navigation.
export function createWakeLock(api = globalThis.navigator?.wakeLock) {
  let sentinel = null;
  let pending = null;
  let wanted = false;
  async function update(enabled) {
    wanted = Boolean(enabled);
    if (!wanted) {
      const previous = sentinel; sentinel = null;
      try { await previous?.release(); } catch {}
      return;
    }
    if (!api || sentinel || pending) return;
    pending = (async () => {
      try {
        const acquired = await api.request("screen");
        if (!wanted) { await acquired.release(); return; }
        sentinel = acquired;
        acquired.addEventListener("release", () => { if (sentinel === acquired) sentinel = null; }, { once: true });
      } catch { /* Browser/OS policy, unsupported or energy-saving mode. */ }
      finally { pending = null; }
    })();
    await pending;
  }
  return { update };
}
