const content = document.querySelector("#content");
const statusText = document.querySelector("#status");
const metaText = document.querySelector("#meta");
const eventTabs = document.querySelector("#event-tabs");
const boardTitle = document.querySelector("#board-title");
const loginLayer = document.querySelector("#login-layer");
const loginForm = document.querySelector("#login-form");
const loginUser = document.querySelector("#login-user");
const loginPass = document.querySelector("#login-pass");
const loginError = document.querySelector("#login-error");

const REFRESH_INTERVAL_MS = 1000;
const SESSION_KEY = "fair91.auth";
const SELECTED_EVENT_KEY = "fair91.selectedEventId";
const ROW_STATS_KEY = "fair91.rowStats";

let refreshTimer = null;
let isFetching = false;
let hasRenderedData = false;
let selectedEventId = "";
let selectedEventName = "";
let loginRows = [];
let eventRows = [];
let rowStats = new Map();
let lastRowsByKey = new Map();
let liveScoreState = {
  data: null,
  error: "",
  fetchedAt: ""
};

function setStatus(message, meta = "") {
  statusText.textContent = message;
  metaText.textContent = meta;
}

function makeStatsKey(eventId, rowKey) {
  return `${eventId || "unknown"}::${rowKey}`;
}

function loadRowStats() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROW_STATS_KEY) || "{}");
    return new Map(Object.entries(saved));
  } catch {
    return new Map();
  }
}

function saveRowStats() {
  localStorage.setItem(ROW_STATS_KEY, JSON.stringify(Object.fromEntries(rowStats)));
}

function simpleValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMaybeJson(value, fallback = value) {
  if (typeof value !== "string") return value ?? fallback;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatus(status, fallback = "") {
  const raw = status || fallback || "";
  return String(raw).trim().toUpperCase();
}

function isActiveStatus(status) {
  return normalizeStatus(status) === "ACTIVE";
}

function setLoginVisible(visible) {
  loginLayer.classList.toggle("hidden", !visible);
}

function saveSession(username) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username }));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function getFieldValue(row, candidates) {
  const entries = Object.entries(row || {});
  for (const key of candidates) {
    const exact = row[key];
    if (exact !== undefined && String(exact).trim() !== "") return String(exact).trim();
  }

  const normCandidates = candidates.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const [key, value] of entries) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normCandidates.includes(norm) && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function normalizeTabularRows(rows) {
  const list = Array.isArray(rows) ? rows : (isPlainObject(rows) ? [rows] : []);
  if (list.length === 0) return [];

  const first = list[0];
  if (!isPlainObject(first)) return list;

  const keys = Object.keys(first);
  if (keys.length === 0) return [];

  const looksLikeLetterCols = keys.every((key) => /^[A-Z]+$/.test(key));
  if (!looksLikeLetterCols || list.length < 2) return list;

  const headerValues = keys.map((key) => String(first[key] || "").trim());
  const hasRealHeaderNames = headerValues.some((value) => /[a-z]/i.test(value) && value.length > 1);
  if (!hasRealHeaderNames) return list;

  return list.slice(1).map((row) => {
    const mapped = {};
    keys.forEach((key, index) => {
      const header = headerValues[index] || key;
      mapped[header] = row[key];
    });
    return mapped;
  });
}

function normalizeLogins(rows) {
  return normalizeTabularRows(rows)
    .map((row) => ({
      username: getFieldValue(row, ["username", "user", "login", "email", "id"]),
      password: getFieldValue(row, ["password", "pass", "pwd", "pin"]),
      name: getFieldValue(row, ["name", "title", "board_name", "display_name"])
    }))
    .filter((row) => row.username && row.password);
}

function normalizeEvents(rows) {
  const events = normalizeTabularRows(rows)
    .map((row) => ({
      id: getFieldValue(row, ["event_id", "eventid", "id", "event"]),
      name: getFieldValue(row, ["event_name", "eventname", "name", "title", "match"]),
      scoreKey: getFieldValue(row, ["score_key", "scorekey", "live_score_key", "livescorekey", "key", "score"])
    }))
    .filter((event) => event.id);

  return events.map((event) => ({ ...event, name: event.name || event.id }));
}

function extractLoginFromLetterColumns(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return [];

  const header = list[0];
  const valueRow = list[1];
  if (!isPlainObject(header) || !isPlainObject(valueRow)) return [];

  const headerA = String(header.A || "").trim().toLowerCase();
  const headerB = String(header.B || "").trim().toLowerCase();
  if (headerA !== "username" || headerB !== "password") return [];

  const username = String(valueRow.A || "").trim();
  const password = String(valueRow.B || "").trim();
  if (!username || !password) return [];

  const name = String(valueRow.C || "").trim();
  return [{ username, password, name }];
}

function applyBoardTitle() {
  const titleFromSheet = loginRows.find((row) => String(row.name || "").trim())?.name;
  boardTitle.textContent = titleFromSheet || "Fair91 Live Board";
}

async function fetchSheetConfig() {
  const response = await fetch("/api/sheet-config");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || "Unable to load sheet config.");
  }
  return payload;
}

function validateLogin(username, password) {
  const inputUser = String(username || "").trim().toLowerCase();
  const inputPass = String(password || "").trim();

  return loginRows.some((row) => {
    const rowUser = String(row.username || "").trim().toLowerCase();
    const rowPass = String(row.password || "").trim();
    return rowUser === inputUser && rowPass === inputPass;
  });
}

function renderTabs() {
  eventTabs.replaceChildren();

  if (eventRows.length === 0) return;

  if (!eventRows.some((row) => row.id === selectedEventId)) {
    const saved = localStorage.getItem(SELECTED_EVENT_KEY) || "";
    const match = eventRows.find((row) => row.id === saved);
    selectedEventId = (match || eventRows[0]).id;
  }

  eventRows.forEach((event) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `event-tab${event.id === selectedEventId ? " active" : ""}`;
    button.textContent = event.name;
    button.dataset.id = event.id;
    button.addEventListener("click", () => {
      if (selectedEventId === event.id) return;
      selectedEventId = event.id;
      selectedEventName = event.name;
      localStorage.setItem(SELECTED_EVENT_KEY, selectedEventId);
      lastRowsByKey = new Map();
      hasRenderedData = false;
      renderTabs();
      startAutoRefresh();
    });
    eventTabs.append(button);
  });

  const selected = eventRows.find((row) => row.id === selectedEventId);
  selectedEventName = selected ? selected.name : selectedEventId;
}

function unwrapApiData(value) {
  if (isPlainObject(value) && isPlainObject(value.data) && (value.data.bkmr || value.data.fancy)) {
    return value.data;
  }
  return value;
}

function buildBookmakerRows(root) {
  const bookmaker = root?.bkmr?.data;
  if (!isPlainObject(bookmaker)) return [];

  const runners = parseMaybeJson(bookmaker.runners, {});
  if (!isPlainObject(runners)) return [];

  return Object.entries(runners)
    .map(([selectionId, runner]) => ({ selectionId, runner }))
    .filter(({ runner }) => isPlainObject(runner))
    .sort((a, b) => Number(a.runner.sort || 0) - Number(b.runner.sort || 0))
    .map(({ selectionId, runner }) => ({
      key: `BOOKMAKER:${runner.selection_id || selectionId}`,
      marketType: "BOOKMAKER",
      label: runner.name,
      backPrice: runner.back_price,
      layPrice: runner.lay_price,
      backSize: runner.back_volume,
      laySize: runner.lay_volume,
      status: normalizeStatus(runner.status, bookmaker.status)
    }));
}

function buildFancyRows(root) {
  const fancy = root?.fancy;
  if (!isPlainObject(fancy)) return [];

  return Object.entries(fancy)
    .map(([selectionId, encoded]) => ({ selectionId, market: parseMaybeJson(encoded, null) }))
    .filter(({ market }) => isPlainObject(market))
    .sort((a, b) => Number(a.market.priority || 0) - Number(b.market.priority || 0) || Number(a.selectionId) - Number(b.selectionId))
    .map(({ selectionId, market }) => ({
      key: `FANCY:${market.id || selectionId}`,
      marketType: "FANCY",
      label: market.name,
      backPrice: market.b1,
      layPrice: market.l1,
      backSize: market.bs1,
      laySize: market.ls1,
      status: normalizeStatus(market.status1)
    }));
}

function buildOddsRows(value) {
  const root = unwrapApiData(value);
  return [...buildBookmakerRows(root), ...buildFancyRows(root)];
}

function updateSeenRange(key, backPrice, layPrice) {
  const storageKey = makeStatsKey(selectedEventId, key);
  const stats = rowStats.get(storageKey) || { min: null, max: null };
  const nums = [toNum(backPrice), toNum(layPrice)].filter((value) => value !== null);
  if (nums.length === 0) return stats;

  const nowMin = Math.min(...nums);
  const nowMax = Math.max(...nums);
  stats.min = stats.min === null ? nowMin : Math.min(stats.min, nowMin);
  stats.max = stats.max === null ? nowMax : Math.max(stats.max, nowMax);
  rowStats.set(storageKey, stats);
  saveRowStats();
  return stats;
}

function createSummary(payload, total) {
  const node = document.createElement("section");
  node.className = "summary";
  node.innerHTML = `
    <div class="summary-item"><span>Event</span><strong>${selectedEventName || payload.id}</strong></div>
    <div class="summary-item"><span>Rows</span><strong>${total}</strong></div>
    <div class="summary-item"><span>Updated</span><strong>${new Date(payload.fetchedAt).toLocaleTimeString()}</strong></div>
  `;
  return node;
}

async function fetchLiveScore() {
  try {
    const selected = eventRows.find((event) => event.id === selectedEventId);
    const scoreKey = selected?.scoreKey || "";

    if (!scoreKey) {
      throw new Error("Live score key missing in Events sheet.");
    }

    const response = await fetch(`/api/live-score?key=${encodeURIComponent(scoreKey)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "Live score request failed.");

    liveScoreState = {
      data: payload.data,
      error: "",
      fetchedAt: payload.fetchedAt
    };
  } catch (error) {
    liveScoreState = {
      data: null,
      error: error.message,
      fetchedAt: new Date().toISOString()
    };
  }
}

const BALL_STATUS_MAP = {
  b: "Ball",
  o: "Over",
  wd: "Wide",
  ba: "Ball in Air",
  f: "Fast Bowler",
  s: "Spin Bowler",
  "^1": "Bowled",
  "^2": "Caught Out",
  "^3": "Caught and Bowled",
  w: "Wicket",
  nb: "No Ball",
  lb: "Leg Bye",
  by: "Bye",
  four: "Four",
  six: "Six"
};

function flattenScoreObjects(value, out = [], depth = 0) {
  const parsed = parseMaybeJson(value, value);
  if (depth > 5) return out;

  if (Array.isArray(parsed)) {
    parsed.forEach((item) => flattenScoreObjects(item, out, depth + 1));
    return out;
  }

  if (!isPlainObject(parsed)) return out;
  out.push(parsed);

  Object.values(parsed).forEach((item) => {
    if (isPlainObject(item) || Array.isArray(item) || (typeof item === "string" && /^[\[{]/.test(item.trim()))) {
      flattenScoreObjects(item, out, depth + 1);
    }
  });
  return out;
}

function firstScoreValue(objects, candidates) {
  const normalized = candidates.map((key) => key.toLowerCase().replace(/[^a-z0-9^]/g, ""));

  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined || value === "") continue;
      const norm = key.toLowerCase().replace(/[^a-z0-9^]/g, "");
      if (normalized.includes(norm)) return value;
    }
  }
  return "";
}

function readScoreModel(data) {
  const objects = flattenScoreObjects(data);
  const selected = eventRows.find((event) => event.id === selectedEventId);
  const teams = splitEventTeams(selectedEventName || selected?.name || "");
  const scoreParts = parseScoreJ(firstScoreValue(objects, ["j", "score_over", "scoreOver", "innings"]));
  const statusCode = String(firstScoreValue(objects, ["b", "ball_status", "ballStatus", "status_code", "statusCode"]) || "").trim();
  const statusText = BALL_STATUS_MAP[statusCode.toLowerCase()] || statusCode || "Live";

  return {
    title: firstScoreValue(objects, ["title", "match_title", "matchTitle", "match", "name"]) || selectedEventName || "Live Match",
    battingTeam: firstScoreValue(objects, ["batting_team", "battingTeam", "team", "batteam", "btm", "t1"]) || teams[0],
    bowlingTeam: firstScoreValue(objects, ["bowling_team", "bowlingTeam", "bowlteam", "t2"]) || teams[1],
    score: firstScoreValue(objects, ["score", "runs", "inning_score", "inningsScore", "scr"]) || scoreParts.runs,
    wickets: firstScoreValue(objects, ["wickets", "wkts", "wicket", "w"]) || scoreParts.wickets,
    overs: scoreParts.overs || firstScoreValue(objects, ["overs", "over", "ov"]),
    crr: firstScoreValue(objects, ["crr", "current_run_rate", "currentRunRate", "rr", "runrate"]) || scoreParts.crr,
    next: firstScoreValue(objects, ["next_to_bowl", "nextToBowl", "opt_to_bowl", "optToBowl", "message", "commentary"]) || "",
    striker: firstScoreValue(objects, ["striker", "batsman1", "batsman", "bat1", "p1"]) || "",
    strikerRuns: firstScoreValue(objects, ["striker_runs", "batsman1_runs", "bat1_runs", "r1"]) || "",
    strikerBalls: firstScoreValue(objects, ["striker_balls", "batsman1_balls", "bat1_balls", "b1"]) || "",
    nonStriker: firstScoreValue(objects, ["non_striker", "nonStriker", "batsman2", "bat2", "p2"]) || "",
    nonStrikerRuns: firstScoreValue(objects, ["non_striker_runs", "batsman2_runs", "bat2_runs", "r2"]) || "",
    nonStrikerBalls: firstScoreValue(objects, ["non_striker_balls", "batsman2_balls", "bat2_balls", "b2"]) || "",
    bowler: firstScoreValue(objects, ["bowler", "current_bowler", "currentBowler", "blw"]) || "",
    bowlerFigures: firstScoreValue(objects, ["bowler_figures", "bowlerFigures", "figures", "bowl_fig"]) || "",
    statusCode,
    statusText,
    overBalls: firstScoreValue(objects, ["A", "balls", "this_over", "thisOver", "last_over", "lastOver", "recentBalls"]) || "",
    projected: firstScoreValue(objects, ["projected", "projected_score", "projectedScore", "projection"]) || ""
  };
}

function splitEventTeams(name) {
  const clean = String(name || "").replace(/\s+/g, " ").trim();
  const parts = clean.split(/\s+v\/?s\.?\s+|\s+vs\.?\s+|\s+v\s+/i).map((part) => part.trim()).filter(Boolean);
  return [parts[0] || "", parts[1] || ""];
}

function parseScoreJ(value) {
  const text = String(value || "").trim();
  const match = text.match(/(\d+)\s*\/\s*(\d+)\s*\(?\s*([0-9]+(?:\.[0-9]+)?)/);

  if (!match) {
    return { runs: "", wickets: "", overs: "", crr: "" };
  }

  const runs = Number(match[1]);
  const wickets = match[2];
  const overs = match[3] || "";
  const balls = oversToBalls(overs);
  const crr = balls > 0 ? ((runs * 6) / balls).toFixed(2) : "";

  return {
    runs: String(runs),
    wickets,
    overs,
    crr
  };
}

function oversToBalls(overs) {
  const [overPart, ballPart = "0"] = String(overs || "").split(".");
  const completedOvers = Number(overPart);
  const balls = Number(ballPart);

  if (!Number.isFinite(completedOvers) || !Number.isFinite(balls)) return 0;
  return completedOvers * 6 + balls;
}

function formatScore(score, wickets) {
  if (!score && !wickets) return "-";
  if (score && String(score).includes("-")) return String(score);
  return `${simpleValue(score)}-${simpleValue(wickets)}`;
}

function formatPlayerLine(name, runs, balls) {
  if (!name) return "-";
  const score = runs || balls ? ` ${simpleValue(runs)} (${simpleValue(balls)})` : "";
  return `${name}${score}`;
}

function createBallPills(value) {
  const wrap = document.createElement("div");
  wrap.className = "score-balls";
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,.|/]+/);
  const balls = raw.map((ball) => String(ball).trim()).filter(Boolean).slice(-12);

  if (balls.length === 0) {
    const pill = document.createElement("span");
    pill.className = "ball-pill muted";
    pill.textContent = "-";
    wrap.append(pill);
    return wrap;
  }

  balls.forEach((ball) => {
    const pill = document.createElement("span");
    const normalized = ball.toLowerCase();
    const label = BALL_STATUS_MAP[normalized] || ball;
    const classes = ["ball-pill"];

    if (/w|\^1|\^2|\^3/i.test(ball)) {
      classes.push("wicket", "event-pulse");
    } else if (normalized === "6" || normalized === "six") {
      classes.push("six", "event-pulse");
    } else if (normalized === "4" || normalized === "four") {
      classes.push("four", "event-pulse");
    }

    pill.className = classes.join(" ");
    pill.title = label;
    pill.textContent = ball;
    wrap.append(pill);
  });
  return wrap;
}

function createLiveScoreSection() {
  const section = document.createElement("section");
  section.className = "live-score-section cricket-score";

  if (liveScoreState.error) {
    section.innerHTML = `<div class="score-title">Live Score</div><div class="live-score-error">${liveScoreState.error}</div>`;
    return section;
  }

  if (!liveScoreState.data) {
    section.innerHTML = '<div class="score-title">Live Score</div><div class="live-score-empty">Loading score...</div>';
    return section;
  }

  const model = readScoreModel(liveScoreState.data);
  section.innerHTML = `
    <div class="score-title">${simpleValue(model.title)}</div>
    <div class="score-hero">
      <div class="team-score">
        <span class="team-name">${simpleValue(model.battingTeam)}</span>
        <div class="score-line">
          <strong>${formatScore(model.score, model.wickets)}</strong>
          <span>${simpleValue(model.overs)}</span>
        </div>
      </div>
      <div class="ball-status">${simpleValue(model.statusText)}</div>
      <div class="score-meta">
        <span>${model.crr ? `CRR : ${model.crr}` : ""}</span>
        <strong>${model.next ? simpleValue(model.next) : (model.bowlingTeam ? `${model.bowlingTeam} to Bowl` : "-")}</strong>
      </div>
    </div>
    <div class="score-live-grid">
      <div class="score-player-card">
        <span>Batsmen</span>
        <strong>${formatPlayerLine(model.striker, model.strikerRuns, model.strikerBalls)}</strong>
        <strong>${formatPlayerLine(model.nonStriker, model.nonStrikerRuns, model.nonStrikerBalls)}</strong>
      </div>
      <div class="score-player-card">
        <span>Bowler</span>
        <strong>${simpleValue(model.bowler)}</strong>
        <strong>${simpleValue(model.bowlerFigures)}</strong>
      </div>
      <div class="score-player-card">
        <span>Projected Score</span>
        <strong>${simpleValue(model.projected)}</strong>
      </div>
    </div>
  `;

  const ballsCard = document.createElement("div");
  ballsCard.className = "score-over-card";
  ballsCard.innerHTML = "<span>Recent Balls</span>";
  ballsCard.append(createBallPills(model.overBalls || model.statusCode));
  section.append(ballsCard);

  return section;
}

function createStatusNode(status) {
  const node = document.createElement("span");
  node.className = "market-status";
  node.textContent = status;
  return node;
}

function addPulseIfChanged(box, key, side, value) {
  const prev = lastRowsByKey.get(key);
  if (!prev) return;
  const prevValue = side === "back" ? prev.backPrice : prev.layPrice;
  if (String(prevValue) !== String(value)) {
    box.classList.add("pulse");
  }
}

function createPriceBox(kind, key, price, size) {
  const box = document.createElement("div");
  box.className = `price-box ${kind}`;
  addPulseIfChanged(box, key, kind === "back" ? "back" : "lay", price);

  const priceNode = document.createElement("strong");
  priceNode.className = "price-value";
  priceNode.textContent = simpleValue(price);
  box.append(priceNode);

  if (size !== undefined) {
    const sizeNode = document.createElement("span");
    sizeNode.className = "size-value";
    sizeNode.textContent = simpleValue(size);
    box.append(sizeNode);
  }
  return box;
}

function createMarketSection(title, columns, rows, fancyMode = false) {
  const section = document.createElement("section");
  section.className = "market-section";

  const table = document.createElement("table");
  table.className = "market-table";
  table.innerHTML = `
    <thead><tr><th>${title}</th><th>${columns[1]}</th><th>${columns[2]}</th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  rows.forEach((rowData) => {
    const tr = document.createElement("tr");
    const range = updateSeenRange(rowData.key, rowData.backPrice, rowData.layPrice);

    const nameCell = document.createElement("td");
    nameCell.className = "name-cell";
    const left = document.createElement("div");
    left.className = "name-wrap";
    const name = document.createElement("span");
    name.className = "name-text";
    name.textContent = simpleValue(rowData.label);
    const minMax = document.createElement("span");
    minMax.className = "seen-range";
    minMax.textContent = `Min ${simpleValue(range.min)} | Max ${simpleValue(range.max)}`;
    left.append(name, minMax);
    nameCell.append(left);
    if (!isActiveStatus(rowData.status)) {
      nameCell.append(createStatusNode(simpleValue(rowData.status)));
    }

    const secondCell = document.createElement("td");
    secondCell.className = "box-cell";
    const thirdCell = document.createElement("td");
    thirdCell.className = "box-cell";

    if (fancyMode) {
      secondCell.append(createPriceBox("lay", rowData.key, rowData.layPrice, rowData.laySize));
      thirdCell.append(createPriceBox("back", rowData.key, rowData.backPrice, rowData.backSize));
    } else {
      secondCell.append(createPriceBox("back", rowData.key, rowData.backPrice));
      thirdCell.append(createPriceBox("lay", rowData.key, rowData.layPrice));
    }

    tr.append(nameCell, secondCell, thirdCell);
    tbody.append(tr);
  });

  section.append(table);
  return section;
}

function createRawPanel(data) {
  const panel = document.createElement("details");
  panel.className = "raw-panel";
  panel.innerHTML = "<summary>Raw API response</summary>";
  const raw = document.createElement("pre");
  raw.textContent = JSON.stringify(data, null, 2);
  panel.append(raw);
  return panel;
}

function renderPayload(payload) {
  const rows = buildOddsRows(payload.data);
  const bookmakerRows = rows.filter((row) => row.marketType === "BOOKMAKER");
  const fancyRows = rows.filter((row) => row.marketType === "FANCY");

  const fragment = document.createDocumentFragment();
  fragment.append(createLiveScoreSection());

  if (bookmakerRows.length) fragment.append(createMarketSection("Bookmaker", ["Bookmaker", "Back", "Lay"], bookmakerRows, false));
  if (fancyRows.length) fragment.append(createMarketSection("Fancy", ["Bookmaker", "No", "Yes"], fancyRows, true));
  if (!bookmakerRows.length && !fancyRows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>No records found</h2><p>This event returned no odds rows.</p>";
    fragment.append(empty);
  }

  fragment.append(createSummary(payload, rows.length));
  fragment.append(createRawPanel(payload.data));
  content.replaceChildren(fragment);
  hasRenderedData = true;

  const nextCache = new Map();
  rows.forEach((row) => nextCache.set(row.key, row));
  lastRowsByKey = nextCache;
}

function renderError(message, detail = "") {
  const error = document.createElement("div");
  error.className = "error-state";
  error.innerHTML = `<h2>${message}</h2><p>${detail}</p>`;
  content.replaceChildren(error);
}

async function fetchSelectedEvent({ manual = false } = {}) {
  if (!selectedEventId || isFetching) return;

  isFetching = true;
  setStatus(manual ? "Fetching odds..." : "Auto-refreshing...", selectedEventName || selectedEventId);

  try {
    const [oddsResult] = await Promise.all([
      fetch(`/api/event-fancy?id=${encodeURIComponent(selectedEventId)}`),
      fetchLiveScore()
    ]);
    const payload = await oddsResult.json();
    if (!oddsResult.ok) throw new Error(payload.detail || payload.error || "Request failed.");
    renderPayload(payload);
    setStatus("Live", `${selectedEventName || selectedEventId} - ${new Date(payload.fetchedAt).toLocaleTimeString()}`);
  } catch (error) {
    if (!hasRenderedData) renderError("Could not load odds", error.message);
    setStatus("Refresh failed", error.message);
  } finally {
    isFetching = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!selectedEventId) return;
  fetchSelectedEvent({ manual: true });
  refreshTimer = window.setInterval(() => fetchSelectedEvent(), REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function initialize() {
  setStatus("Loading", "Reading Google Sheets config");
  rowStats = loadRowStats();

  try {
    const config = await fetchSheetConfig();
    loginRows = normalizeLogins(config.loginRows || []);
    eventRows = normalizeEvents(config.eventRows || []);

    if (loginRows.length === 0) {
      loginRows = normalizeLogins(config.eventRows);
    }

    if (loginRows.length === 0) {
      loginRows = extractLoginFromLetterColumns(config.eventRows);
    }

    applyBoardTitle();

    window.__fair91Debug = {
      loginRows,
      eventRows
    };

    if (eventRows.length === 0) {
      renderError("No events available", "Events sheet is empty or missing event IDs.");
      setStatus("No events", "");
      return;
    }

    const session = loadSession();
    if (!session) {
      setLoginVisible(true);
      setStatus("Login required", "");
      renderTabs();
      return;
    }

    selectedEventId = localStorage.getItem(SELECTED_EVENT_KEY) || eventRows[0].id;
    renderTabs();
    startAutoRefresh();
  } catch (error) {
    renderError("Startup failed", error.message);
    setStatus("Error", error.message);
  }
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = loginUser.value.trim();
  const password = loginPass.value;

  if (!validateLogin(username, password)) {
    loginError.textContent = `Invalid username or password. Loaded credential rows: ${loginRows.length}`;
    return;
  }

  loginError.textContent = "";
  saveSession(username);
  setLoginVisible(false);

  selectedEventId = localStorage.getItem(SELECTED_EVENT_KEY) || eventRows[0].id;
  renderTabs();
  startAutoRefresh();
});

initialize();
