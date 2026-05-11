const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const ROW_STATS_FILE = path.join(__dirname, "row-stats.json");
const BETTING_LEDGER_FILE = path.join(__dirname, "betting-ledger.json");
const ODDS_ENDPOINT = "https://oddsapi.fair91.com/odds/event-fancy";
const LIVE_SCORE_ENDPOINT = "https://api.goscorer.com/api/v3/getSV3";
const CRICBUZZ_LIVE_SCORE_ENDPOINT = "https://www.cricbuzz.com/api/mcenter/livescore";
const SHEET_ID = "1pQQ6IedQjTdEAkfGjG7cGFFge5KXLrsDyTGKT56MevI";
const SHEET_NAMES = {
  login: "Login Details",
  events: "Events"
};
const SHEETS_API_URL = (process.env.FAIR91_SHEETS_API_URL || readOptionalText("google-sheets-api-url.txt")).trim();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function readOptionalText(fileName) {
  try {
    return fs.readFileSync(path.join(__dirname, fileName), "utf8");
  } catch {
    return "";
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function loadRowStatsStore() {
  try {
    const raw = fs.readFileSync(ROW_STATS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveRowStatsStore(store) {
  fs.writeFileSync(ROW_STATS_FILE, JSON.stringify(store, null, 2));
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function callSheetsApi(action, payload = {}) {
  if (!SHEETS_API_URL) {
    throw new Error("Google Sheets API URL is not configured. Put the deployed Apps Script web app URL in google-sheets-api-url.txt or set FAIR91_SHEETS_API_URL.");
  }

  const response = await fetch(SHEETS_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "user-agent": "Fair91OddsViewer/1.0"
    },
    body: JSON.stringify({ action, payload })
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    throw new Error(body.detail || body.error || `Google Sheets API failed (${response.status}).`);
  }
  return body;
}

async function handleSheetsBackedApi(req, res, action) {
  try {
    const payload = req.method === "GET" ? {} : await readJsonBody(req);
    const result = await callSheetsApi(action, payload);
    sendJson(res, Number(result.statusCode || 200), result);
  } catch (error) {
    sendJson(res, 502, {
      error: "Unable to read or write Google Sheets data.",
      detail: error.message
    });
  }
}

function loadBettingLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BETTING_LEDGER_FILE, "utf8"));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      bets: Array.isArray(parsed.bets) ? parsed.bets : []
    };
  } catch {
    return { users: [], bets: [] };
  }
}

function saveBettingLedger(ledger) {
  fs.writeFileSync(BETTING_LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

function betProfit(stake, odds) {
  return Number((odds > 20 ? (stake * odds) / 100 : stake * Math.max(0, odds - 1)).toFixed(2));
}

function fancyRateAmount(stake, rate) {
  return Number(((stake * rate) / 100).toFixed(2));
}

function fancyLiability(stake, rate, side) {
  return side === "No" ? fancyRateAmount(stake, rate) : stake;
}

function fancyProfit(stake, rate, side) {
  return side === "Yes" ? fancyRateAmount(stake, rate) : stake;
}

function publicLedger(ledger) {
  const summary = ledger.users.map((user) => {
    const userBets = ledger.bets.filter((bet) => String(bet.username).toLowerCase() === String(user.username).toLowerCase());
    const pending = userBets.filter((bet) => bet.status === "PENDING");
    const settled = userBets.filter((bet) => bet.status === "SETTLED");
    return {
      username: user.username,
      name: user.name,
      balance: numericValue(user.balance) || 0,
      totalStake: userBets.reduce((sum, bet) => sum + (numericValue(bet.stake) || 0), 0),
      exposure: pending.reduce((sum, bet) => sum + (numericValue(bet.stake) || 0), 0),
      pnl: settled.reduce((sum, bet) => sum + (numericValue(bet.pnl) || 0), 0),
      betCount: userBets.length
    };
  });

  return {
    users: ledger.users.map(({ password, ...user }) => user),
    bets: ledger.bets,
    summary
  };
}

async function handleRowStats(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const eventId = String(body.eventId || "").trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!eventId) {
      sendJson(res, 400, { error: "Missing required field: eventId" });
      return;
    }

    const store = loadRowStatsStore();
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
    saveRowStatsStore(store);

    sendJson(res, 200, {
      eventId,
      fetchedAt: new Date().toISOString(),
      stats: eventStats
    });
  } catch (error) {
    sendJson(res, 400, {
      error: "Unable to update row stats.",
      detail: error.message
    });
  }
}

async function handleBettingAuth(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  try {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const ledger = loadBettingLedger();
    const user = ledger.users.find((row) => String(row.username || "").trim().toLowerCase() === username && String(row.password || "") === password);
    if (!user) return sendJson(res, 401, { error: "Invalid username or password." });
    const { password: _password, ...safeUser } = user;
    sendJson(res, 200, { user: safeUser });
  } catch (error) {
    sendJson(res, 400, { error: "Unable to authenticate.", detail: error.message });
  }
}

async function handleBettingUsers(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  try {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const name = String(body.name || username).trim();
    const balance = numericValue(body.balance) || 0;
    if (!username || !password) return sendJson(res, 400, { error: "Username and password are required." });

    const ledger = loadBettingLedger();
    if (ledger.users.some((user) => String(user.username).toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: "User already exists." });
    }

    const user = { username, password, name, role: "user", balance, createdAt: new Date().toISOString() };
    ledger.users.push(user);
    saveBettingLedger(ledger);
    const { password: _password, ...safeUser } = user;
    sendJson(res, 200, { user: safeUser });
  } catch (error) {
    sendJson(res, 400, { error: "Unable to create user.", detail: error.message });
  }
}

async function handleBets(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  try {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const stake = numericValue(body.stake);
    const odds = numericValue(body.odds);
    const rate = numericValue(body.rate);
    const liability = numericValue(body.liability) || (body.marketType === "FANCY" ? fancyLiability(stake, rate, body.side) : stake);
    if (!username || !stake || stake <= 0 || !odds || odds <= 0) {
      return sendJson(res, 400, { error: "Valid username, stake and odds are required." });
    }

    const ledger = loadBettingLedger();
    const user = ledger.users.find((row) => String(row.username).toLowerCase() === username.toLowerCase());
    if (!user) return sendJson(res, 404, { error: "User not found in betting ledger. Master must create the user first." });
    const balance = numericValue(user.balance) || 0;
    if (balance < liability) return sendJson(res, 400, { error: "Insufficient balance." });

    user.balance = Number((balance - liability).toFixed(2));
    const bet = {
      id: Math.random().toString(16).slice(2, 14),
      username,
      eventId: body.eventId,
      eventName: body.eventName,
      marketKey: body.marketKey,
      marketName: body.marketName,
      marketType: body.marketType,
      side: body.side,
      odds,
      target: body.target,
      rate: body.rate,
      stake,
      liability,
      estimatedProfit: body.marketType === "FANCY" ? fancyProfit(stake, rate, body.side) : betProfit(stake, odds),
      status: "PENDING",
      result: "",
      pnl: 0,
      placedAt: new Date().toISOString()
    };
    ledger.bets.push(bet);
    saveBettingLedger(ledger);
    sendJson(res, 200, { bet, ledger: publicLedger(ledger) });
  } catch (error) {
    sendJson(res, 400, { error: "Unable to place bet.", detail: error.message });
  }
}

async function handleBetSettle(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  try {
    const body = await readJsonBody(req);
    const result = String(body.result || "").toUpperCase();
    const ledger = loadBettingLedger();
    const bet = ledger.bets.find((row) => row.id === body.betId);
    if (!bet) return sendJson(res, 404, { error: "Bet not found." });
    if (bet.status !== "PENDING") return sendJson(res, 400, { error: "Bet is already settled." });
    const user = ledger.users.find((row) => String(row.username).toLowerCase() === String(bet.username).toLowerCase());
    const stake = numericValue(bet.stake) || 0;
    const liability = numericValue(bet.liability) || stake;
    const profit = numericValue(bet.estimatedProfit) || 0;

    if (result === "WIN") {
      bet.pnl = profit;
      user.balance = Number(((numericValue(user.balance) || 0) + liability + profit).toFixed(2));
    } else if (result === "LOSE") {
      bet.pnl = -liability;
    } else if (result === "VOID") {
      bet.pnl = 0;
      user.balance = Number(((numericValue(user.balance) || 0) + liability).toFixed(2));
    } else {
      return sendJson(res, 400, { error: "Result must be WIN, LOSE or VOID." });
    }

    bet.status = "SETTLED";
    bet.result = result;
    bet.settledAt = new Date().toISOString();
    saveBettingLedger(ledger);
    sendJson(res, 200, { bet, ledger: publicLedger(ledger) });
  } catch (error) {
    sendJson(res, 400, { error: "Unable to settle bet.", detail: error.message });
  }
}

function sendStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

async function proxyOdds(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const id = requestUrl.searchParams.get("id")?.trim();

  if (!id) {
    sendJson(res, 400, { error: "Missing required query parameter: id" });
    return;
  }

  const upstreamUrl = new URL(ODDS_ENDPOINT);
  upstreamUrl.searchParams.set("id", id);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "Fair91OddsViewer/1.0"
      }
    });

    const contentType = upstreamResponse.headers.get("content-type") || "";
    const bodyText = await upstreamResponse.text();
    let body = bodyText;

    if (contentType.includes("application/json") || bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    if (!upstreamResponse.ok) {
      sendJson(res, upstreamResponse.status, {
        error: "The odds API returned an error.",
        status: upstreamResponse.status,
        body
      });
      return;
    }

    sendJson(res, 200, {
      id,
      fetchedAt: new Date().toISOString(),
      source: upstreamUrl.toString(),
      data: body
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Unable to fetch odds from the remote API.",
      detail: error.message
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyLiveScore(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const key = requestUrl.searchParams.get("key")?.trim();
  const pathMatch = requestUrl.pathname.match(/^\/api\/mcenter\/livescore\/([^/]+)$/);
  const matchId = requestUrl.searchParams.get("matchId")?.trim() || (pathMatch ? decodeURIComponent(pathMatch[1]).trim() : "");

  if (!key && !matchId) {
    sendJson(res, 400, { error: "Missing live score key or Cricbuzz match ID." });
    return;
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
    const upstreamResponse = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://www.cricbuzz.com/",
        "user-agent": "Fair91OddsViewer/1.0"
      }
    });

    const contentType = upstreamResponse.headers.get("content-type") || "";
    const bodyText = await upstreamResponse.text();
    let body = bodyText;

    if (contentType.includes("application/json") || bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    if (!upstreamResponse.ok) {
      sendJson(res, upstreamResponse.status, {
        error: "The live score API returned an error.",
        status: upstreamResponse.status,
        body
      });
      return;
    }

    sendJson(res, 200, {
      fetchedAt: new Date().toISOString(),
      sourceType: matchId ? "cricbuzz" : "goscorer",
      source: upstreamUrl.toString(),
      data: body
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Unable to fetch live score.",
      detail: error.message
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseGvizResponse(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Invalid Google Sheets response format.");
  }

  const payload = JSON.parse(text.slice(start, end + 1));
  const cols = payload?.table?.cols || [];
  const rows = payload?.table?.rows || [];

  const headers = cols.map((col, index) => {
    const raw = String(col?.label || col?.id || `col${index + 1}`).trim();
    return raw || `col${index + 1}`;
  });

  return rows.map((row) => {
    const cells = row?.c || [];
    const obj = {};
    headers.forEach((header, index) => {
      const cell = cells[index];
      const value = cell?.f ?? cell?.v ?? "";
      obj[header] = value === null || value === undefined ? "" : String(value);
    });
    return obj;
  });
}

async function fetchSheetRows(sheetName) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`);
  url.searchParams.set("sheet", sheetName);
  url.searchParams.set("tqx", "out:json");

  const response = await fetch(url, {
    headers: {
      accept: "text/plain, */*",
      "user-agent": "Fair91OddsViewer/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to load "${sheetName}" sheet.`);
  }

  const text = await response.text();
  return parseGvizResponse(text);
}

async function proxySheetConfig(res) {
  try {
    const [loginRows, eventRows] = await Promise.all([
      fetchSheetRows(SHEET_NAMES.login),
      fetchSheetRows(SHEET_NAMES.events)
    ]);

    sendJson(res, 200, {
      fetchedAt: new Date().toISOString(),
      loginRows,
      eventRows
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Unable to load Google Sheet configuration.",
      detail: error.message
    });
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/api/event-fancy") {
    proxyOdds(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/sheet-config") {
    proxySheetConfig(res);
    return;
  }

  if (requestUrl.pathname === "/api/row-stats") {
    handleSheetsBackedApi(req, res, "rowStats");
    return;
  }

  if (requestUrl.pathname === "/api/betting-ledger") {
    handleSheetsBackedApi(req, res, "getLedger");
    return;
  }

  if (requestUrl.pathname === "/api/betting-auth") {
    handleSheetsBackedApi(req, res, "auth");
    return;
  }

  if (requestUrl.pathname === "/api/betting-users") {
    handleSheetsBackedApi(req, res, "createUser");
    return;
  }

  if (requestUrl.pathname === "/api/bets") {
    handleSheetsBackedApi(req, res, "placeBet");
    return;
  }

  if (requestUrl.pathname === "/api/bets/settle") {
    handleSheetsBackedApi(req, res, "settleBet");
    return;
  }

  if (requestUrl.pathname === "/api/live-score" || requestUrl.pathname.startsWith("/api/mcenter/livescore/")) {
    proxyLiveScore(req, res);
    return;
  }

  sendStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Fair91 odds viewer running at http://localhost:${PORT}`);
});
