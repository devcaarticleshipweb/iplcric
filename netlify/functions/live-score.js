const LIVE_SCORE_ENDPOINT = "https://api.goscorer.com/api/v3/getSV3";

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

  if (!key) {
    return json(400, { error: "Missing required query parameter: key" });
  }

  const upstreamUrl = new URL(LIVE_SCORE_ENDPOINT);
  upstreamUrl.searchParams.set("key", key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
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
