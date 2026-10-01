// Enkel minnebasert teller: holder for én prosess på en Pi, nullstilles ved omstart.
function createLimiter({ windowMs, max }) {
  const hits = new Map();

  function recent(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    isLimited(key) {
      return recent(key).length >= max;
    },
    hit(key) {
      if (hits.size > 10000) hits.clear();
      hits.set(key, [...recent(key), Date.now()]);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createLimiter };
