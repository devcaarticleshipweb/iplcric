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
let lastOverStripSignature = "";
let overStripScrollLeft = null;
let liveScoreCompact = false;

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
      scoreKey: getFieldValue(row, ["score_key", "scorekey", "live_score_key", "livescorekey", "key", "score"]),
      cricbuzzMatchId: getFieldValue(row, ["cricbuzz_match_id", "cricbuzzmatchid", "cricbuzz_id", "cricbuzzid", "match_id", "matchid"]),
      team1Short: getFieldValue(row, ["team1_short", "team1short", "team_1_short", "team 1 short", "team 1 short name", "team1_short_name", "team1shortname", "team1", "team_1", "team 1"]),
      team2Short: getFieldValue(row, ["team2_short", "team2short", "team_2_short", "team 2 short", "team 2 short name", "team2_short_name", "team2shortname", "team2", "team_2", "team 2"])
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
    const cricbuzzMatchId = selected?.cricbuzzMatchId || "";

    if (!scoreKey) {
      throw new Error("Live score key missing in Events sheet.");
    }

    const scorePayload = await fetchJsonPayload(`/api/live-score?key=${encodeURIComponent(scoreKey)}`);
    let cricbuzzPayload = null;

    if (cricbuzzMatchId) {
      try {
        cricbuzzPayload = await fetchJsonPayload(`/api/mcenter/livescore/${encodeURIComponent(cricbuzzMatchId)}`);
      } catch {
        cricbuzzPayload = null;
      }
    }

    liveScoreState = {
      data: {
        scoreData: scorePayload.data,
        cricbuzzData: cricbuzzPayload?.data || null
      },
      error: "",
      fetchedAt: scorePayload.fetchedAt
    };
  } catch (error) {
    liveScoreState = {
      data: null,
      error: error.message,
      fetchedAt: new Date().toISOString()
    };
  }
}

async function fetchJsonPayload(url) {
  const response = await fetch(url);
  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || "Live score request failed." };
  }

  if (!response.ok) {
    const message = payload.detail || payload.error || `Live score request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

const BALL_STATUS_MAP = {
  b: "Ball",
  o: "Over",
  wd: "Wide",
  ba: "Ball in Air",
  f: "Fast Bowler",
  s: "Spin Bowler",
  ruka: "Bowler Stopped",
  "^1": "Bowled",
  "^2": "Caught Out",
  "^3": "Caught and Bowled",
  w: "Wicket",
  nb: "No Ball",
  lb: "Leg Bye",
  by: "Bye",
  "4": "Four",
  "6": "Six",
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

function firstExactScoreValue(objects, candidates) {
  const normalized = candidates.map((key) => key.toLowerCase());

  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined || value === "") continue;
      if (normalized.includes(key.toLowerCase())) return value;
    }
  }
  return "";
}

function scoreFieldValue(objects, source, keyName) {
  const exact = firstExactScoreValue(objects, [keyName]);
  if (exact !== "") return exact;

  try {
    const escaped = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const text = JSON.stringify(source);
    const direct = text.match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`, "i"));
    if (direct) return direct[1];

    const nested = text.match(new RegExp(`\\\\"${escaped}\\\\"\\s*:\\s*\\\\"([^"\\\\]*)`, "i"));
    return nested ? nested[1] : "";
  } catch {
    return "";
  }
}

function scoreOverValues(objects, source) {
  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    const entries = Object.entries(obj);
    const hasLastOver = entries.some(([key, value]) => key.toLowerCase() === "n" && parsePastOver(value));
    if (!hasLastOver) continue;

    const grouped = ["l", "m", "n"].map((wanted) => {
      const match = entries.find(([key]) => key.toLowerCase() === wanted);
      return match && parsePastOver(match[1]) ? match[1] : "";
    });

    if (grouped.filter(Boolean).length > 1) return grouped;
  }

  const nearby = scoreOverValuesFromText(source);
  if (nearby.filter(Boolean).length > 1) return nearby;

  const values = ["l", "m", "n"].map((key) => {
    const value = scoreFieldValue(objects, source, key);
    return parsePastOver(value) ? value : "";
  }).filter(Boolean);
  if (values.length >= 3) return values;

  try {
    const text = JSON.stringify(source).replace(/\\"/g, '"');
    const matches = [...text.matchAll(/"([0-9]{1,2}:[^"]+)"/g)].map((match) => match[1]);
    const unique = [...new Set(matches)].filter((value) => /^\d{1,2}:/.test(value));
    unique.sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]));
    return unique.slice(-3);
  } catch {
    return values;
  }
}

function scoreOverValuesFromText(source) {
  try {
    const text = JSON.stringify(source).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const found = {};
    const patterns = [
      /["']?([lmn])["']?\s*[:=]\s*["']?(\d{1,2}:[0-9a-zA-Z.^]+)["']?/g,
      /\\?["']([lmn])\\?["']\s*:\s*\\?["'](\d{1,2}:[0-9a-zA-Z.^]+)\\?["']/g
    ];

    patterns.forEach((pattern) => {
      let match = pattern.exec(text);
      while (match) {
        const key = match[1].toLowerCase();
        const value = match[2];
        if (parsePastOver(value)) found[key] = value;
        match = pattern.exec(text);
      }
    });

    return [found.l || "", found.m || "", found.n || ""];
  } catch {
    return ["", "", ""];
  }
}

function findObjectWithKeys(objects, candidates) {
  const normalized = candidates.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ""));

  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    const keys = Object.keys(obj).map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (normalized.some((key) => keys.includes(key))) return obj;
  }
  return null;
}

function firstBatterValue(objects, keyName, fallbackName) {
  const target = keyName.toLowerCase().replace(/[^a-z0-9^]/g, "");

  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined || value === "") continue;
      const norm = key.toLowerCase().replace(/[^a-z0-9^]/g, "");
      if (norm !== target) continue;

      const batter = parseBatterField(value, fallbackName);
      if (batter.name || batter.runs || batter.balls) return batter;
    }
  }
  return {};
}

function parseCricbuzzBatter(player, forceStriker = false) {
  if (!isPlainObject(player)) return {};
  const name = player.batName || player.name || player.fullName || player.nickName || player.batsmanName || "";
  const runs = player.batRuns ?? player.runs ?? player.score ?? "";
  const balls = player.batBalls ?? player.balls ?? "";
  const fours = player.batFours ?? player.fours ?? player["4s"] ?? player.boundaries ?? "";
  const sixes = player.batSixes ?? player.sixes ?? player["6s"] ?? "";
  const strikeRate = player.batStrikeRate ?? player.strikeRate ?? player.sr ?? "";
  const isStriker = forceStriker || Boolean(player.isStriker || player.strike || player.onStrike);
  return {
    name: `${name || "Batter"}${isStriker ? " *" : ""}`,
    runs: runs === null || runs === undefined ? "" : String(runs),
    balls: balls === null || balls === undefined ? "" : String(balls),
    fours: fours === null || fours === undefined ? "" : String(fours),
    sixes: sixes === null || sixes === undefined ? "" : String(sixes),
    strikeRate: strikeRate === null || strikeRate === undefined ? "" : String(strikeRate),
    isStriker
  };
}

function formatCricbuzzBowlerFigures(player) {
  if (!isPlainObject(player)) return "";
  const overs = player.bowlOvs ?? player.overs ?? player.ovs ?? "";
  const runs = player.bowlRuns ?? player.runs ?? "";
  const wickets = player.bowlWkts ?? player.wickets ?? player.wkts ?? "";
  const economy = player.bowlEcon ?? player.economy ?? player.econ ?? "";
  const parts = [];
  if (overs !== "") parts.push(`${overs} ov`);
  if (wickets !== "" || runs !== "") parts.push(`${simpleValue(wickets)}-${simpleValue(runs)}`);
  if (economy !== "") parts.push(`Econ ${economy}`);
  return parts.join(" ");
}

function economyValue(runs, oversOrBalls, fallback = "") {
  if (fallback) {
    const value = Number(fallback);
    return Number.isFinite(value) ? value.toFixed(2) : simpleValue(fallback);
  }

  const runValue = Number(runs);
  if (!Number.isFinite(runValue)) return "-";

  const text = String(oversOrBalls || "").trim();
  let balls = 0;
  if (text.includes(".")) {
    balls = oversToBalls(text);
  } else {
    const numeric = Number(text);
    balls = Number.isFinite(numeric) && numeric > 6 ? numeric : numeric * 6;
  }

  if (!Number.isFinite(balls) || balls <= 0) return "-";
  return ((runValue * 6) / balls).toFixed(2);
}

function parseCricbuzzBowler(player, isCurrent = false) {
  if (!isPlainObject(player)) return {};
  const name = player.bowlName || player.name || player.bowlerName || player.fullName || player.nickName || "";
  const runs = player.bowlRuns ?? player.runs ?? player.conceded ?? "";
  const overs = player.bowlOvs ?? player.overs ?? player.ovs ?? "";
  const wickets = player.bowlWkts ?? player.wickets ?? player.wkts ?? "";
  const extras = player.bowlExtras ?? player.extras ?? player.extraRuns ?? "";
  const economy = player.bowlEcon ?? player.economy ?? player.econ ?? "";

  if (!name && runs === "" && overs === "" && wickets === "") return {};

  return {
    name,
    runs: runs === null || runs === undefined ? "" : String(runs),
    overs: overs === null || overs === undefined ? "" : String(overs),
    wickets: wickets === null || wickets === undefined ? "" : String(wickets),
    extras: extras === null || extras === undefined ? "" : String(extras),
    economy: economy === null || economy === undefined ? "" : String(economy),
    isCurrent
  };
}

function collectCricbuzzBowlers(objects, currentBowler, extraBowlers = []) {
  const bowlers = [];
  const addBowler = (bowler) => {
    if (!bowler.name && !bowler.runs && !bowler.overs && !bowler.wickets) return;
    const key = normalizeTeamKey(bowler.name || JSON.stringify(bowler));
    const existing = bowlers.find((item) => normalizeTeamKey(item.name || JSON.stringify(item)) === key);
    if (existing) {
      if (bowler.isCurrent) existing.isCurrent = true;
      Object.keys(bowler).forEach((field) => {
        if ((existing[field] === "" || existing[field] === undefined) && bowler[field] !== "") existing[field] = bowler[field];
      });
      return;
    }
    bowlers.push(bowler);
  };

  addBowler(currentBowler);
  extraBowlers.forEach(addBowler);

  objects.forEach((obj) => {
    if (!isPlainObject(obj)) return;
    const hasBowlerName = obj.bowlName || obj.bowlerName || obj.bowler || obj.currentBowler;
    const hasBowlingFigures = obj.bowlOvs !== undefined || obj.bowlRuns !== undefined || obj.bowlWkts !== undefined || obj.bowlEcon !== undefined;
    if (!hasBowlerName || !hasBowlingFigures) return;
    addBowler(parseCricbuzzBowler(obj, false));
  });

  return bowlers
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
    .slice(0, 2);
}

function normalizeTeamKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamAcronym(value) {
  const clean = String(value || "").trim();
  if (/^[A-Z0-9]{2,5}$/.test(clean)) return clean;

  return clean
    .replace(/\([^)]*\)/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/gi, ""))
    .filter((word) => word && !/^(vs?|v|the|and)$/i.test(word))
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function teamNameParts(team, fallback = "") {
  if (!isPlainObject(team)) return [team || fallback].filter(Boolean);
  return [
    team.shortName,
    team.teamSName,
    team.teamShortName,
    team.teamAbbr,
    team.abbr,
    team.name,
    team.teamName,
    fallback
  ].filter(Boolean);
}

function displayTeamName(team, fallback = "") {
  if (isPlainObject(team)) return team.shortName || team.teamSName || team.teamShortName || team.name || team.teamName || fallback;
  return team || fallback;
}

function teamMatches(value, team, fallback = "") {
  const needle = normalizeTeamKey(value);
  const names = teamNameParts(team, fallback)
    .flatMap((name) => [name, teamAcronym(name)])
    .map(normalizeTeamKey)
    .filter(Boolean);
  return names.some((name) => name === needle || name.includes(needle) || needle.includes(name));
}

function pairedTeamNames(battingName, team1Obj, team2Obj, fallbackTeams) {
  const team1 = displayTeamName(team1Obj, fallbackTeams[0]);
  const team2 = displayTeamName(team2Obj, fallbackTeams[1]);

  if (teamMatches(battingName, team1Obj, fallbackTeams[0])) {
    return { battingTeam: team1, bowlingTeam: team2 };
  }

  if (teamMatches(battingName, team2Obj, fallbackTeams[1])) {
    return { battingTeam: team2, bowlingTeam: team1 };
  }

  return {
    battingTeam: battingName || team1,
    bowlingTeam: normalizeTeamKey(battingName) === normalizeTeamKey(team2) ? team1 : team2
  };
}

function teamCandidatesFromObjects(objects, fallbackTeams) {
  const candidates = [];

  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    const hasTeamName = obj.teamName || obj.teamSName || obj.teamShortName || obj.shortName || obj.name;
    if (!hasTeamName) continue;

    const display = displayTeamName(obj);
    const key = normalizeTeamKey(display);
    if (!key || candidates.some((team) => team.key === key)) continue;
    candidates.push({ raw: obj, display, key });
  }

  fallbackTeams.forEach((team) => {
    const display = displayTeamName(team);
    const key = normalizeTeamKey(display);
    if (key && !candidates.some((candidate) => candidate.key === key)) {
      candidates.push({ raw: team, display, key });
    }
  });

  return candidates;
}

function pairedTeamNamesFromCandidates(battingName, candidates, fallbackTeams) {
  const batKey = normalizeTeamKey(battingName);
  const matched = candidates.find((team) => {
    const names = teamNameParts(team.raw, team.display).map(normalizeTeamKey).filter(Boolean);
    return names.some((name) => name === batKey || name.includes(batKey) || batKey.includes(name));
  });

  if (matched) {
    const other = candidates.find((team) => team.key !== matched.key);
    return {
      battingTeam: battingName || matched.display,
      bowlingTeam: other?.display || ""
    };
  }

  return pairedTeamNames(battingName, fallbackTeams[0], fallbackTeams[1], fallbackTeams);
}

function pairedTeamsFromSheetShorts(battingName, event, teams) {
  const short1 = event?.team1Short || teamAcronym(teams[0]);
  const short2 = event?.team2Short || teamAcronym(teams[1]);
  if (!short1 || !short2 || !battingName) return null;

  const batKey = normalizeTeamKey(battingName);
  const team1Key = normalizeTeamKey(short1);
  const team2Key = normalizeTeamKey(short2);

  if (batKey === team1Key || batKey.includes(team1Key) || team1Key.includes(batKey)) {
    return {
      battingTeam: short1,
      bowlingTeam: short2
    };
  }

  if (batKey === team2Key || batKey.includes(team2Key) || team2Key.includes(batKey)) {
    return {
      battingTeam: short2,
      bowlingTeam: short1
    };
  }

  return null;
}

function readCricbuzzModel(data, objects, teams, selectedEvent) {
  const header = data?.matchHeader || findObjectWithKeys(objects, ["matchDescription", "team1", "team2"]);
  const miniscore = data?.miniscore || data?.miniScore || findObjectWithKeys(objects, ["matchScoreDetails", "batsmanStriker", "bowlerStriker"]);
  const scoreDetails = miniscore?.matchScoreDetails || data?.matchScoreDetails || {};
  const innings = scoreDetails?.inningsScoreList || miniscore?.inningsScoreList || data?.inningsScoreList || [];
  const inningsList = Array.isArray(innings) ? innings.filter(isPlainObject) : [];
  const activeInnings = inningsList[inningsList.length - 1] || {};
  const team1Obj = header?.team1 || teams[0];
  const team2Obj = header?.team2 || teams[1];
  const batTeamName =
    firstScoreValue(objects, ["batTeamName"]) ||
    data?.batTeamName ||
    miniscore?.batTeamName ||
    miniscore?.batTeam?.batTeamName ||
    scoreDetails?.batTeamName ||
    activeInnings.batTeamName ||
    activeInnings.teamName ||
    activeInnings.batTeamShortName ||
    "";
  const teamCandidates = teamCandidatesFromObjects(objects, [team1Obj, team2Obj, ...teams]);
  const pairedTeams = pairedTeamsFromSheetShorts(batTeamName, selectedEvent, teams) || pairedTeamNamesFromCandidates(batTeamName, teamCandidates, teams);
  const battingTeam = batTeamName || pairedTeams.battingTeam;
  let bowlingTeam = pairedTeams.bowlingTeam;
  if (normalizeTeamKey(bowlingTeam) === normalizeTeamKey(battingTeam)) {
    const short1 = selectedEvent?.team1Short || teamAcronym(teams[0]);
    const short2 = selectedEvent?.team2Short || teamAcronym(teams[1]);
    bowlingTeam = teamMatches(battingTeam, teams[0], short1) || normalizeTeamKey(battingTeam) === normalizeTeamKey(short1) ? short2 : short1;
  }
  const striker = parseCricbuzzBatter(miniscore?.batsmanStriker || data?.batsmanStriker || miniscore?.striker, true);
  const nonStriker = parseCricbuzzBatter(miniscore?.batsmanNonStriker || data?.batsmanNonStriker || miniscore?.nonStriker, false);
  const bowler = miniscore?.bowlerStriker || miniscore?.currentBowler || {};
  const currentBowler = parseCricbuzzBowler(bowler, true);
  const previousBowler = parseCricbuzzBowler(miniscore?.bowlerNonStriker || data?.bowlerNonStriker || miniscore?.nonStrikerBowler, false);
  const bowlers = collectCricbuzzBowlers(objects, currentBowler, [previousBowler]);
  const runs = activeInnings.score ?? activeInnings.runs ?? "";
  const wickets = activeInnings.wickets ?? activeInnings.wkts ?? "";
  const overs = activeInnings.overs ?? activeInnings.ovs ?? "";
  const balls = oversToBalls(overs);
  const crr = balls > 0 && runs !== "" ? ((Number(runs) * 6) / balls).toFixed(2) : "";

  if (!header && !miniscore && inningsList.length === 0) return null;

  return {
    title: header?.matchDescription || header?.matchDesc || header?.status || selectedEventName || "Live Match",
    battingTeam,
    bowlingTeam,
    score: runs,
    wickets,
    overs,
    crr: miniscore?.currentRunRate || miniscore?.crr || crr,
    next: header?.status || miniscore?.status || "",
    striker: striker.name || "",
    strikerRuns: striker.runs || "",
    strikerBalls: striker.balls || "",
    strikerFours: striker.fours || "",
    strikerSixes: striker.sixes || "",
    strikerStrikeRate: striker.strikeRate || "",
    nonStriker: nonStriker.name || "",
    nonStrikerRuns: nonStriker.runs || "",
    nonStrikerBalls: nonStriker.balls || "",
    nonStrikerFours: nonStriker.fours || "",
    nonStrikerSixes: nonStriker.sixes || "",
    nonStrikerStrikeRate: nonStriker.strikeRate || "",
    bowler: bowler.bowlName || bowler.name || bowler.bowlerName || "",
    bowlerFigures: formatCricbuzzBowlerFigures(bowler),
    bowlers
  };
}

function readScoreModel(data) {
  const scoreData = isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, "scoreData") ? data.scoreData : data;
  const cricbuzzData = isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, "cricbuzzData") ? data.cricbuzzData : null;
  const objects = flattenScoreObjects(scoreData);
  const cricbuzzObjects = cricbuzzData ? flattenScoreObjects(cricbuzzData) : [];
  const selected = eventRows.find((event) => event.id === selectedEventId);
  const teams = splitEventTeams(selectedEventName || selected?.name || "");
  const cricbuzz = cricbuzzData ? readCricbuzzModel(cricbuzzData, cricbuzzObjects, teams, selected) : null;
  const firstInningsRaw = firstScoreValue(objects, ["j"]);
  const secondInningsRaw = firstScoreValue(objects, ["k"]);
  const isSecondInnings = Boolean(firstInningsRaw && secondInningsRaw);
  const firstInnings = parseScoreJ(firstInningsRaw);
  const activeInnings = parseScoreJ(secondInningsRaw || firstInningsRaw || firstScoreValue(objects, ["score_over", "scoreOver", "innings"]));
  const activeTeam = isSecondInnings ? teams[1] : teams[0];
  const fieldingTeam = isSecondInnings ? teams[0] : teams[1];
  const target = isSecondInnings && firstInnings.runs ? Number(firstInnings.runs) + 1 : "";
  const ballsRemaining = isSecondInnings ? Math.max(0, 120 - oversToBalls(activeInnings.overs)) : "";
  const runsNeeded = isSecondInnings && target !== "" ? Math.max(0, target - Number(activeInnings.runs || 0)) : "";
  const chaseComplete = isSecondInnings && target !== "" && runsNeeded === 0;
  const rrr = isSecondInnings && ballsRemaining > 0 ? ((runsNeeded * 6) / ballsRemaining).toFixed(2) : "";
  const chaseMessage = isSecondInnings && !chaseComplete ? `${activeTeam || "Team 2"} need ${runsNeeded} runs in ${ballsRemaining} balls` : "";
  const statusCode = String(firstScoreValue(objects, ["b", "ball_status", "ballStatus", "status_code", "statusCode"]) || "").trim();
  const statusText = BALL_STATUS_MAP[statusCode.toLowerCase()] || statusCode || "Live";
  const goScorerBowlerRaw = firstScoreValue(objects, ["c"]);
  const bowlerFigures = formatGoScorerBowlerFigures(goScorerBowlerRaw) || firstScoreValue(objects, ["bowler_figures", "bowlerFigures", "figures", "bowl_fig"]) || "";
  const overValues = scoreOverValues(objects, scoreData);
  const overLast1 = parsePastOver(scoreFieldValue(objects, scoreData, "n")) ? scoreFieldValue(objects, scoreData, "n") : overValues[2] || "";
  const overLast2 = parsePastOver(scoreFieldValue(objects, scoreData, "m")) ? scoreFieldValue(objects, scoreData, "m") : overValues[1] || "";
  const overLast3 = parsePastOver(scoreFieldValue(objects, scoreData, "l")) ? scoreFieldValue(objects, scoreData, "l") : overValues[0] || "";
  const qBatter = firstBatterValue(objects, "q", "Batter 1");
  const sBatter = firstBatterValue(objects, "s", "Batter 2");
  const parsedBatters = [qBatter, sBatter].filter((batter) => batter.name || batter.runs || batter.balls);
  const orderedBatters = parsedBatters.length
    ? [...parsedBatters].sort((a, b) => Number(b.isStriker) - Number(a.isStriker))
    : [];
  const firstBatter = orderedBatters[0] || {};
  const secondBatter = orderedBatters[1] || {};
  const bowlerName = cricbuzz?.bowler || firstScoreValue(objects, ["bowler", "current_bowler", "currentBowler", "blw"]) || "";
  const goScorerBowler = parseGoScorerBowler(goScorerBowlerRaw, bowlerName);
  const cricbuzzBowlers = Array.isArray(cricbuzz?.bowlers) ? cricbuzz.bowlers : [];
  const bowlers = cricbuzzBowlers.length ? cricbuzzBowlers.map((bowler, index) => {
    if (index !== 0) return bowler;
    return {
      ...bowler,
      runs: goScorerBowler.runs || bowler.runs,
      overs: goScorerBowler.overs || bowler.overs,
      wickets: goScorerBowler.wickets || bowler.wickets,
      extras: goScorerBowler.extras || bowler.extras,
      economy: goScorerBowler.economy || bowler.economy,
      isCurrent: true
    };
  }) : (goScorerBowler.name || goScorerBowler.runs ? [goScorerBowler] : []);

  return {
    title: cricbuzz?.title || firstScoreValue(objects, ["title", "match_title", "matchTitle", "match", "name"]) || selectedEventName || "Live Match",
    battingTeam: cricbuzz?.battingTeam || (isSecondInnings ? activeTeam : firstScoreValue(objects, ["batting_team", "battingTeam", "team", "batteam", "btm", "t1"]) || activeTeam),
    bowlingTeam: cricbuzz?.bowlingTeam || (isSecondInnings ? fieldingTeam : firstScoreValue(objects, ["bowling_team", "bowlingTeam", "bowlteam", "t2"]) || fieldingTeam),
    score: isSecondInnings ? activeInnings.runs : firstScoreValue(objects, ["score", "runs", "inning_score", "inningsScore", "scr"]) || activeInnings.runs,
    wickets: isSecondInnings ? activeInnings.wickets : firstScoreValue(objects, ["wickets", "wkts", "wicket", "w"]) || activeInnings.wickets,
    overs: activeInnings.overs || firstScoreValue(objects, ["overs", "over", "ov"]),
    crr: chaseComplete ? "" : (isSecondInnings ? activeInnings.crr : firstScoreValue(objects, ["crr", "current_run_rate", "currentRunRate", "rr", "runrate"]) || activeInnings.crr),
    rrr: chaseComplete ? "" : rrr,
    completedTeam: chaseComplete ? (cricbuzz?.bowlingTeam || fieldingTeam || "Team 1") : "",
    completedScore: chaseComplete ? firstInnings.runs : "",
    completedWickets: chaseComplete ? firstInnings.wickets : "",
    completedOvers: chaseComplete ? firstInnings.overs : "",
    next: chaseComplete ? "" : chaseMessage || firstScoreValue(objects, ["next_to_bowl", "nextToBowl", "opt_to_bowl", "optToBowl", "message", "commentary"]) || "",
    striker: cricbuzz?.striker || firstBatter.name || firstScoreValue(objects, ["striker", "batsman1", "batsman", "bat1", "p1"]) || "",
    strikerRuns: firstBatter.runs || firstScoreValue(objects, ["striker_runs", "batsman1_runs", "bat1_runs", "r1"]) || "",
    strikerBalls: firstBatter.balls || firstScoreValue(objects, ["striker_balls", "batsman1_balls", "bat1_balls", "b1"]) || "",
    strikerFours: cricbuzz?.strikerFours || firstScoreValue(objects, ["striker_fours", "striker4s", "batsman1_fours", "bat1_fours", "fours1"]) || "",
    strikerSixes: cricbuzz?.strikerSixes || firstScoreValue(objects, ["striker_sixes", "striker6s", "batsman1_sixes", "bat1_sixes", "sixes1"]) || "",
    strikerStrikeRate: cricbuzz?.strikerStrikeRate || firstScoreValue(objects, ["striker_sr", "strikerStrikeRate", "batsman1_sr", "bat1_sr", "sr1"]) || "",
    nonStriker: cricbuzz?.nonStriker || secondBatter.name || firstScoreValue(objects, ["non_striker", "nonStriker", "batsman2", "bat2", "p2"]) || "",
    nonStrikerRuns: secondBatter.runs || firstScoreValue(objects, ["non_striker_runs", "batsman2_runs", "bat2_runs", "r2"]) || "",
    nonStrikerBalls: secondBatter.balls || firstScoreValue(objects, ["non_striker_balls", "batsman2_balls", "bat2_balls", "b2"]) || "",
    nonStrikerFours: cricbuzz?.nonStrikerFours || firstScoreValue(objects, ["non_striker_fours", "nonStriker4s", "batsman2_fours", "bat2_fours", "fours2"]) || "",
    nonStrikerSixes: cricbuzz?.nonStrikerSixes || firstScoreValue(objects, ["non_striker_sixes", "nonStriker6s", "batsman2_sixes", "bat2_sixes", "sixes2"]) || "",
    nonStrikerStrikeRate: cricbuzz?.nonStrikerStrikeRate || firstScoreValue(objects, ["non_striker_sr", "nonStrikerStrikeRate", "batsman2_sr", "bat2_sr", "sr2"]) || "",
    bowler: bowlerName,
    bowlerFigures,
    bowlers,
    statusCode,
    statusText,
    overBalls: firstScoreValue(objects, ["A", "balls", "this_over", "thisOver", "last_over", "lastOver", "recentBalls"]) || "",
    overHistory: {
      current: scoreFieldValue(objects, scoreData, "A") || "",
      last1: overLast1,
      last2: overLast2,
      last3: overLast3
    },
    projectedLabel: target ? "Target" : "Projected Score",
    projected: target || firstScoreValue(objects, ["projected", "projected_score", "projectedScore", "projection"]) || ""
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

function ballsToOvers(value) {
  const totalBalls = Number(value);
  if (!Number.isFinite(totalBalls) || totalBalls < 0) return "";
  const overs = Math.floor(totalBalls / 6);
  const balls = totalBalls % 6;
  return `${overs}.${balls}`;
}

function parseGoScorerBowler(value, name = "") {
  const parts = String(value || "").split(".").map((part) => part.trim());
  if (parts.length < 3 || parts.some((part, index) => index < 3 && part === "")) return {};

  const [runs, balls, wickets, extras = ""] = parts;
  const overs = ballsToOvers(balls);
  return {
    name,
    runs,
    overs,
    wickets,
    extras,
    economy: economyValue(runs, balls),
    isCurrent: true
  };
}

function formatGoScorerBowlerFigures(value) {
  const bowler = parseGoScorerBowler(value);
  if (!bowler.runs && !bowler.wickets) return "";
  return `${simpleValue(bowler.wickets)}-${simpleValue(bowler.runs)}${bowler.overs ? ` (${bowler.overs})` : ""}`;
}

function parseBatterField(value, fallbackName = "Batter") {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};

  if (raw.length > 80 || /[|,]/.test(raw)) return {};

  const scoreMatches = raw.match(/\*?\d+\.\d+\*?/g) || [];
  if (scoreMatches.length !== 1) return {};

  const scoreMatch = scoreMatches[0];
  const isStriker = raw.includes("*");
  const scoreText = scoreMatch.replace(/\*/g, "");
  const [runs = "", balls = ""] = scoreText.split(".");
  const name = raw
    .replace(scoreMatch, "")
    .replace(/\*/g, "")
    .replace(/[-:|]+$/g, "")
    .trim();

  return {
    name: `${name || fallbackName}${isStriker ? " *" : ""}`,
    runs,
    balls,
    isStriker
  };
}

function formatScore(score, wickets) {
  if (!score && !wickets) return "-";
  if (score && String(score).includes("-")) return String(score);
  return `${simpleValue(score)}-${simpleValue(wickets)}`;
}

function formatOvers(overs) {
  const value = simpleValue(overs);
  return value === "-" ? value : `(${value})`;
}

function formatPlayerLine(name, runs, balls) {
  if (!name) return "-";
  const isStriker = String(name).includes("*");
  const cleanName = String(name).replace(/\*/g, "").trim();
  const nameMarkup = `${simpleValue(cleanName)}${isStriker ? ' <span class="bat-icon" title="On strike">🏏</span>' : ""}`;
  const score = runs || balls ? ` ${simpleValue(runs)} (${simpleValue(balls)})` : "";
  return `${nameMarkup}${score}`;
}

function strikeRateValue(runs, balls, fallback = "") {
  if (fallback) {
    const fallbackValue = Number(fallback);
    return Number.isFinite(fallbackValue) ? String(Math.round(fallbackValue)) : simpleValue(fallback);
  }
  const runValue = Number(runs);
  const ballValue = Number(balls);
  if (!Number.isFinite(runValue) || !Number.isFinite(ballValue) || ballValue <= 0) return "-";
  return String(Math.round((runValue / ballValue) * 100));
}

function batterNameMarkup(name) {
  if (!name) return "-";
  const isStriker = String(name).includes("*");
  const cleanName = String(name).replace(/\*/g, "").trim();
  return `${simpleValue(cleanName)}${isStriker ? ' <span class="bat-icon" title="On strike">🏏</span>' : ""}`;
}

function createBatterGrid(model) {
  const rows = [
    {
      name: model.striker,
      runs: model.strikerRuns,
      balls: model.strikerBalls,
      fours: model.strikerFours,
      sixes: model.strikerSixes,
      strikeRate: model.strikerStrikeRate
    },
    {
      name: model.nonStriker,
      runs: model.nonStrikerRuns,
      balls: model.nonStrikerBalls,
      fours: model.nonStrikerFours,
      sixes: model.nonStrikerSixes,
      strikeRate: model.nonStrikerStrikeRate
    }
  ].filter((row) => row.name || row.runs || row.balls);

  if (rows.length === 0) {
    return '<div class="scorecard-grid batter-grid scorecard-grid-empty">Batsman data unavailable</div>';
  }

  return `
    <div class="scorecard-grid batter-grid" role="table" aria-label="Batsman scorecard">
      <div class="scorecard-grid-row batter-grid-row scorecard-grid-head" role="row">
        <span role="columnheader">Batsman</span>
        <span role="columnheader">Run</span>
        <span role="columnheader">Ball</span>
        <span role="columnheader">4s</span>
        <span role="columnheader">6s</span>
        <span role="columnheader">SR</span>
      </div>
      ${rows.map((row) => `
        <div class="scorecard-grid-row batter-grid-row" role="row">
          <span class="batter-name-cell" role="cell">${batterNameMarkup(row.name)}</span>
          <span role="cell">${simpleValue(row.runs)}</span>
          <span role="cell">${simpleValue(row.balls)}</span>
          <span role="cell">${simpleValue(row.fours)}</span>
          <span role="cell">${simpleValue(row.sixes)}</span>
          <span role="cell">${strikeRateValue(row.runs, row.balls, row.strikeRate)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function bowlerNameMarkup(name, isCurrent = false) {
  if (!name) return "-";
  return `${simpleValue(name)}${isCurrent ? ' <span class="ball-icon" title="Currently bowling"></span>' : ""}`;
}

function createBowlerGrid(model) {
  const rows = (Array.isArray(model.bowlers) ? model.bowlers : [])
    .filter((row) => row.name || row.runs || row.overs || row.wickets)
    .slice(0, 2);

  if (rows.length === 0 && (model.bowler || model.bowlerFigures)) {
    rows.push({
      name: model.bowler,
      runs: "",
      overs: "",
      wickets: "",
      extras: "",
      economy: "",
      isCurrent: true
    });
  }

  if (rows.length === 0) {
    return '<div class="scorecard-grid bowler-grid scorecard-grid-empty">Bowler data unavailable</div>';
  }

  return `
    <div class="scorecard-grid bowler-grid" role="table" aria-label="Bowler scorecard">
      <div class="scorecard-grid-row bowler-grid-row scorecard-grid-head" role="row">
        <span role="columnheader">Bowler</span>
        <span role="columnheader">Run</span>
        <span role="columnheader">Over</span>
        <span role="columnheader">Wicket</span>
        <span role="columnheader">Extras</span>
        <span role="columnheader">Economy</span>
      </div>
      ${rows.map((row) => `
        <div class="scorecard-grid-row bowler-grid-row" role="row">
          <span class="bowler-name-cell" role="cell">${bowlerNameMarkup(row.name, row.isCurrent)}</span>
          <span role="cell">${simpleValue(row.runs)}</span>
          <span role="cell">${simpleValue(row.overs)}</span>
          <span role="cell">${simpleValue(row.wickets)}</span>
          <span role="cell">${simpleValue(row.extras)}</span>
          <span role="cell">${economyValue(row.runs, row.overs, row.economy)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function tokenizeBallEvents(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,.|/]+/);
  return raw.map((ball) => String(ball).trim()).filter(Boolean);
}

function ballRunValue(ball) {
  const token = String(ball || "").trim().toLowerCase();
  const numeric = Number(token);
  if (Number.isFinite(numeric)) return numeric;
  if (token === "wd" || token === "wide" || token === "nb" || token === "noball") return 1;
  return 0;
}

function parsePastOver(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const [overNo, ballsText = ""] = text.split(":");
  if (!/^\d{1,2}$/.test(overNo.replace(/\\"/g, "").trim())) return null;
  const balls = ballsText.replace(/\\"/g, "").split(".").map((ball) => ball.trim()).filter(Boolean);
  if (!overNo || balls.length === 0) return null;

  return {
    number: Number(overNo),
    label: `Over ${overNo.replace(/\\"/g, "")}`,
    balls,
    total: balls.reduce((sum, ball) => sum + ballRunValue(ball), 0)
  };
}

function parseCurrentOver(value, label) {
  const balls = tokenizeBallEvents(value);
  if (balls.length === 0) return null;
  const slots = [...balls];
  while (slots.length < 6) slots.push("");

  return {
    label: label || "Current",
    balls: slots,
    total: balls.reduce((sum, ball) => sum + ballRunValue(ball), 0)
  };
}

function createOverStrip(model) {
  const strip = document.createElement("div");
  strip.className = "over-strip";

  const historyOvers = [
    parsePastOver(model.overHistory?.last3),
    parsePastOver(model.overHistory?.last2),
    parsePastOver(model.overHistory?.last1)
  ].filter(Boolean);
  const lastOverNo = parsePastOver(model.overHistory?.last1)?.number;
  const currentLabel = Number.isFinite(lastOverNo) ? `Over ${lastOverNo + 1}` : "Current";
  const currentOver = parseCurrentOver(model.overHistory?.current, currentLabel);

  if (historyOvers.length === 0 && !currentOver) return strip;

  historyOvers.forEach((over) => {
    const item = document.createElement("div");
    item.className = "over-strip-item";

    const title = document.createElement("span");
    title.className = "over-label";
    title.textContent = over.label;
    item.append(title);

    const balls = document.createElement("div");
    balls.className = "score-balls";
    over.balls.forEach((ball) => balls.append(createBallPill(ball)));
    item.append(balls);

    const total = document.createElement("strong");
    total.className = "over-total";
    total.textContent = `= ${over.total}`;
    item.append(total);

    strip.append(item);
  });

  if (currentOver) {
    const item = document.createElement("div");
    item.className = "over-strip-item current";

    const title = document.createElement("span");
    title.className = "over-label";
    title.textContent = currentOver.label;
    item.append(title);

    const balls = document.createElement("div");
    balls.className = "score-balls";
    currentOver.balls.forEach((ball) => balls.append(createBallPill(ball)));
    item.append(balls);

    const total = document.createElement("strong");
    total.className = "over-total";
    total.textContent = `= ${currentOver.total}`;
    item.append(total);

    strip.append(item);
  }

  return strip;
}

function createBallPill(ball) {
  const pill = document.createElement("span");
  if (ball === "") {
    pill.className = "ball-pill muted";
    pill.textContent = "";
    return pill;
  }

  const normalized = String(ball).toLowerCase();
  const label = BALL_STATUS_MAP[normalized] || ball;
  const classes = ["ball-pill"];
  let display = ball;

  if (normalized === "wd" || normalized === "wide") {
    classes.push("wide");
    display = "WD";
  } else if (normalized === "nb" || normalized === "noball") {
    classes.push("wide");
    display = "NB";
  } else if (/^w$|\^1|\^2|\^3/i.test(String(ball))) {
    classes.push("wicket");
    display = "W";
  } else if (normalized === "6" || normalized === "six") {
    classes.push("six");
    display = "6";
  } else if (normalized === "4" || normalized === "four") {
    classes.push("four");
    display = "4";
  }

  pill.className = classes.join(" ");
  pill.title = label;
  pill.textContent = display;
  return pill;
}

function createBallPills(value) {
  const wrap = document.createElement("div");
  wrap.className = "score-balls";
  const balls = tokenizeBallEvents(value).slice(-12);

  if (balls.length === 0) {
    const pill = document.createElement("span");
    pill.className = "ball-pill muted";
    pill.textContent = "-";
    wrap.append(pill);
    return wrap;
  }

  balls.forEach((ball) => {
    wrap.append(createBallPill(ball));
  });
  return wrap;
}

function createLiveScoreSection() {
  const section = document.createElement("section");
  section.className = "live-score-section cricket-score";
  if (liveScoreCompact) section.classList.add("score-compact");

  if (liveScoreState.error) {
    section.innerHTML = `<div class="score-title">Live Score</div><div class="live-score-error">${liveScoreState.error}</div>`;
    return section;
  }

  if (!liveScoreState.data) {
    section.innerHTML = '<div class="score-title">Live Score</div><div class="live-score-empty">Loading score...</div>';
    return section;
  }

  const model = readScoreModel(liveScoreState.data);
  window.__fair91LastScoreModel = model;
  window.__fair91TeamDebug = () => ({
    selectedEventId,
    selectedEventName,
    event: eventRows.find((event) => event.id === selectedEventId),
    battingTeam: model.battingTeam,
    bowlingTeam: model.bowlingTeam,
    completedTeam: model.completedTeam,
    cricbuzz: liveScoreState.data?.cricbuzzData || null
  });
  section.innerHTML = `
    <div class="score-title">
      <span>${simpleValue(model.title)}</span>
      <button type="button" class="score-toggle" aria-pressed="${liveScoreCompact ? "true" : "false"}">
        ${liveScoreCompact ? "Full" : "Compact"}
      </button>
    </div>
    <div class="score-hero">
      <div class="team-score">
        <span class="team-name">${simpleValue(model.battingTeam)}</span>
        <div class="score-line">
          <strong>${formatScore(model.score, model.wickets)}</strong>
          <span>${formatOvers(model.overs)}</span>
        </div>
      </div>
      <div class="ball-status">${simpleValue(model.statusText)}</div>
      ${model.completedTeam ? `
        <div class="team-score score-meta-team">
          <span class="team-name">${simpleValue(model.completedTeam)}</span>
          <div class="score-line">
            <strong>${formatScore(model.completedScore, model.completedWickets)}</strong>
            <span>${formatOvers(model.completedOvers)}</span>
          </div>
        </div>
      ` : `
        <div class="score-meta">
          <span>${[model.crr ? `CRR : ${model.crr}` : "", model.rrr ? `RRR : ${model.rrr}` : ""].filter(Boolean).join(" | ")}</span>
          <strong>${model.next ? simpleValue(model.next) : (model.bowlingTeam ? `${model.bowlingTeam} to Bowl` : "-")}</strong>
        </div>
      `}
    </div>
    <div class="score-live-grid">
      <div class="score-player-card batter-card">
        ${createBatterGrid(model)}
      </div>
      <div class="score-player-card bowler-card">
        ${createBowlerGrid(model)}
      </div>
      <div class="score-player-card">
        <span>${simpleValue(model.projectedLabel || "Projected Score")}</span>
        <strong>${simpleValue(model.projected)}</strong>
      </div>
    </div>
  `;

  section.querySelector(".score-toggle")?.addEventListener("click", () => {
    liveScoreCompact = !liveScoreCompact;
    renderCurrentData();
  });

  const overStrip = createOverStrip(model);
  if (overStrip.childElementCount) {
    section.querySelector(".score-hero").after(overStrip);
    const signature = JSON.stringify(model.overHistory || {});
    overStrip.addEventListener("scroll", () => {
      overStripScrollLeft = overStrip.scrollLeft;
    }, { passive: true });

    if (signature !== lastOverStripSignature) {
      lastOverStripSignature = signature;
      requestAnimationFrame(() => {
        overStrip.scrollLeft = overStrip.scrollWidth;
        overStripScrollLeft = overStrip.scrollLeft;
      });
    } else if (overStripScrollLeft !== null) {
      requestAnimationFrame(() => {
        overStrip.scrollLeft = overStripScrollLeft;
      });
    }
  }

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
