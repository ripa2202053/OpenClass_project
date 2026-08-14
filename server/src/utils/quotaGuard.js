/**
 * Server-side Firestore quota error detection and caching helper.
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

const serverCache = new Map();

export function getCachedServerData(key) {
  const item = serverCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    serverCache.delete(key);
    return null;
  }
  return item.data;
}

export function setCachedServerData(key, data, ttlMs = 30000) {
  serverCache.set(key, {
    data,
    expiry: Date.now() + ttlMs,
  });
}

export function clearServerCache(keyPrefix) {
  if (!keyPrefix) {
    serverCache.clear();
    return;
  }
  for (const key of serverCache.keys()) {
    if (key.startsWith(keyPrefix) || key.includes(keyPrefix)) {
      serverCache.delete(key);
    }
  }
}

/**
 * Executes a server Firestore query block with caching and quota-exceeded fallback.
 */
export async function safeServerQuery(key, queryFn, fallbackVal = [], ttlMs = 30000) {
  const cached = getCachedServerData(key);
  if (cached !== null) {
    return cached;
  }

  try {
    const res = await queryFn();
    if (res !== null && res !== undefined) {
      setCachedServerData(key, res, ttlMs);
    }
    return res;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn(`[Server QuotaGuard] Firestore RESOURCE_EXHAUSTED for key "${key}". Serving cached/fallback data.`);
      const stale = serverCache.get(key);
      if (stale) return stale.data;
      return fallbackVal;
    }
    throw err;
  }
}
