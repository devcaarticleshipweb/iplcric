const ODDS_ENDPOINT = "https://oddsapi.fair91.com/odds/event-fancy";

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
  const id = String(event.queryStringParameters?.id || "").trim();

  if (!id) {
    return json(400, { error: "Missing required query parameter: id" });
  }

  const upstreamUrl = new URL(ODDS_ENDPOINT);
  upstreamUrl.searchParams.set("id", id);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

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
        error: "The odds API returned an error.",
        status: response.status,
        body
      });
    }

    return json(200, {
      id,
      fetchedAt: new Date().toISOString(),
      source: upstreamUrl.toString(),
      data: body
    });
  } catch (error) {
    return json(502, {
      error: "Unable to fetch odds from the remote API.",
      detail: error.message
    });
  } finally {
    clearTimeout(timeout);
  }
};
