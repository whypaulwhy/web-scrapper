/**
 * Small in-memory cache with a time-to-live and a size cap (oldest entries are evicted first).
 * On Vercel each warm function instance keeps its own copy; that is enough to stop repeated
 * requests for the same page from spending the free AI quota.
 */
export function createCache({ ttlMs, maxEntries }) {
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value) {
      if (ttlMs <= 0) return;
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
