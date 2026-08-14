import { onSnapshot } from 'firebase/firestore';

/**
 * Checks if an error is a Firestore quota exceeded / RESOURCE_EXHAUSTED error.
 */
export function isQuotaExceededError(err) {
  if (!err) return false;
  const code = err.code;
  const msg = String(err.message || err.details || '').toUpperCase();
  return (
    code === 8 ||
    code === 'RESOURCE_EXHAUSTED' ||
    code === 'resource-exhausted' ||
    (code === 'permission-denied' && msg.includes('QUOTA')) ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('QUOTA EXCEEDED') ||
    msg.includes('QUOTA_EXCEEDED')
  );
}

/**
 * In-memory cache helper with TTL and in-flight promise deduplication.
 */
export function createRequestCache(defaultTtlMs = 30000) {
  const cache = new Map();
  const pendingPromises = new Map();

  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiry) {
        cache.delete(key);
        return null;
      }
      return entry.data;
    },
    set(key, data, ttlMs = defaultTtlMs) {
      cache.set(key, {
        data,
        expiry: Date.now() + ttlMs,
      });
    },
    async execute(key, fetchFn, ttlMs = defaultTtlMs) {
      const cached = this.get(key);
      if (cached !== null && cached !== undefined) {
        return cached;
      }
      if (pendingPromises.has(key)) {
        return pendingPromises.get(key);
      }

      const promise = (async () => {
        try {
          const res = await fetchFn();
          if (res !== null && res !== undefined) {
            this.set(key, res, ttlMs);
          }
          return res;
        } catch (err) {
          if (isQuotaExceededError(err)) {
            console.warn('[RequestCache] Quota exceeded (RESOURCE_EXHAUSTED). Returning stale cache or null.');
            const stale = cache.get(key);
            if (stale) return stale.data;
          }
          throw err;
        } finally {
          pendingPromises.delete(key);
        }
      })();

      pendingPromises.set(key, promise);
      return promise;
    },
    clear() {
      cache.clear();
      pendingPromises.clear();
    }
  };
}

/**
 * Creates a debounced wrapper around an async function to avoid rapid repeated calls.
 */
export function createDebouncedAsync(fn, delayMs = 300) {
  let timer = null;
  let activePromise = null;

  return function (...args) {
    if (activePromise) return activePromise;

    activePromise = new Promise((resolve, reject) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const result = await fn(...args);
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          activePromise = null;
          timer = null;
        }
      }, delayMs);
    });

    return activePromise;
  };
}

/**
 * Safe wrapper for onSnapshot that:
 * 1. Provides a default error handler catching RESOURCE_EXHAUSTED / code 8 without crashing.
 * 2. Deduplicates emissions using JSON serialization comparison to prevent infinite loop triggers.
 */
export function safeOnSnapshot(targetQuery, onNext, onErrorOrFallback = null, label = 'onSnapshot') {
  let lastHash = '';

  return onSnapshot(
    targetQuery,
    (snap) => {
      try {
        const hash = snap.docs
          ? snap.docs.map(d => `${d.id}:${JSON.stringify(d.data())}`).join('|')
          : (snap.exists() ? `${snap.id}:${JSON.stringify(snap.data())}` : 'null');

        if (hash === lastHash) {
          return; // Skip duplicate notification to prevent render/query loop
        }
        lastHash = hash;

        if (typeof onNext === 'function') {
          onNext(snap);
        }
      } catch (err) {
        console.warn(`[FirestoreGuard] ${label} callback processing error:`, err);
      }
    },
    (err) => {
      if (isQuotaExceededError(err)) {
        console.warn(`[FirestoreGuard] ${label}: Quota exceeded (RESOURCE_EXHAUSTED). Preserving local state.`);
      } else {
        console.warn(`[FirestoreGuard] ${label} listener error:`, err.message || err);
      }

      if (typeof onErrorOrFallback === 'function') {
        try {
          onErrorOrFallback(err);
        } catch (e) {
          console.warn(`[FirestoreGuard] ${label} fallback error:`, e);
        }
      }
    }
  );
}
