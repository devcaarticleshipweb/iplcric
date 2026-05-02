const LIVE_SCORE_ENDPOINT = "https://api.goscorer.com/api/v3/getSV3";
const CRICBUZZ_LIVE_SCORE_ENDPOINT = "https://www.cricbuzz.com/api/mcenter/livescore";

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

exports.handler = async (event) => {
  const key = String(event.queryStringParameters?.key || "").trim();
  const pathMatch = String(event.path || event.rawUrl || "").match(/\/api\/mcenter\/livescore\/([^/?#]+)/);
  const matchId = String(event.queryStringParameters?.matchId || (pathMatch ? decodeURIComponent(pathMatch[1]) : "")).trim();

  if (!key && !matchId) {
    return json(400, { error: "Missing live score key or Cricbuzz match ID." });
  }

  const upstreamUrl = matchId
    ? new URL(`${CRICBUZZ_LIVE_SCORE_ENDPOINT}/${encodeURIComponent(matchId)}`)
    : new URL(LIVE_SCORE_ENDPOINT);

  if (!matchId) {
    upstreamUrl.searchParams.set("key", key);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://www.cricbuzz.com/",
        "user-agent": "Fair91OddsViewer/1.0"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let body = text;

    if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      return json(response.status, {
        error: "The live score API returned an error.",
        status: response.status,
        body
      });
    }

    return json(200, {
      fetchedAt: new Date().toISOString(),
      sourceType: matchId ? "cricbuzz" : "goscorer",
      source: upstreamUrl.toString(),
      data: body
    });
  } catch (error) {
    return json(502, {
      error: "Unable to fetch live score.",
      detail: error.message
    });
  } finally {
    clearTimeout(timeout);
  }
};
