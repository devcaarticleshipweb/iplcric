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

let refreshTimer = null;
let isFetching = false;
let hasRenderedData = false;
let selectedEventId = "";
let selectedEventName = "";
let loginRows = [];
let eventRows = [];
let rowStats = new Map();
let lastRowsByKey = new Map();

function setStatus(message, meta = "") {
  statusText.textContent = message;
  metaText.textContent = meta;
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
      name: getFieldValue(row, ["event_name", "eventname", "name", "title", "match"])
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
      rowStats = new Map();
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
  const stats = rowStats.get(key) || { min: null, max: null };
  const nums = [toNum(backPrice), toNum(layPrice)].filter((value) => value !== null);
  if (nums.length === 0) return stats;

  const nowMin = Math.min(...nums);
  const nowMax = Math.max(...nums);
  stats.min = stats.min === null ? nowMin : Math.min(stats.min, nowMin);
  stats.max = stats.max === null ? nowMax : Math.max(stats.max, nowMax);
  rowStats.set(key, stats);
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
  fragment.append(createSummary(payload, rows.length));

  if (bookmakerRows.length) fragment.append(createMarketSection("Bookmaker", ["Bookmaker", "Back", "Lay"], bookmakerRows, false));
  if (fancyRows.length) fragment.append(createMarketSection("Fancy", ["Bookmaker", "No", "Yes"], fancyRows, true));
  if (!bookmakerRows.length && !fancyRows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<h2>No records found</h2><p>This event returned no odds rows.</p>";
    fragment.append(empty);
  }

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
    const response = await fetch(`/api/event-fancy?id=${encodeURIComponent(selectedEventId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "Request failed.");
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
