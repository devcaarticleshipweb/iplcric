const store = globalThis.__fair91RowStatsStore || {};
globalThis.__fair91RowStatsStore = store;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const eventId = String(body.eventId || "").trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!eventId) {
      return json(400, { error: "Missing required field: eventId" });
    }

    const eventStats = store[eventId] && typeof store[eventId] === "object" ? store[eventId] : {};

    rows.forEach((row) => {
      const key = String(row?.key || "").trim();
      if (!key) return;

      const values = [numericValue(row.backPrice), numericValue(row.layPrice)].filter((value) => value !== null);
      if (values.length === 0) return;

      const current = eventStats[key] && typeof eventStats[key] === "object" ? eventStats[key] : { min: null, max: null };
      const nowMin = Math.min(...values);
      const nowMax = Math.max(...values);
      current.min = current.min === null || current.min === undefined ? nowMin : Math.min(Number(current.min), nowMin);
      current.max = current.max === null || current.max === undefined ? nowMax : Math.max(Number(current.max), nowMax);
      eventStats[key] = current;
    });

    store[eventId] = eventStats;

    return json(200, {
      eventId,
      fetchedAt: new Date().toISOString(),
      stats: eventStats
    });
  } catch (error) {
    return json(400, {
      error: "Unable to update row stats.",
      detail: error.message
    });
  }
};
