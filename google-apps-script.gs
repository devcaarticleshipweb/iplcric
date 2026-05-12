const SHEETS = {
  login: "Login Details",
  users: "User Ledger",
  bets: "Bet Ledger",
  rowStats: "Row Stats"
};

const HEADERS = {
  login: ["username", "password", "name", "role"],
  users: ["username", "password", "name", "role", "balance", "createdAt"],
  bets: ["id", "username", "eventId", "eventName", "marketKey", "marketName", "marketType", "side", "odds", "run", "target", "rate", "stake", "liability", "estimatedProfit", "status", "result", "pnl", "placedAt", "settledAt", "statusAtSelection", "verifiedAt"],
  rowStats: ["eventId", "rowKey", "min", "max", "updatedAt"]
};

function doPost(e) {
  try {
    const request = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : "{}");
    const action = request.action;
    const payload = request.payload || {};

    ensureSheets();

    if (action === "rowStats") return jsonResponse(updateRowStats(payload));
    if (action === "getLedger") return jsonResponse(publicLedger());
    if (action === "auth") return jsonResponse(authUser(payload));
    if (action === "createUser") return jsonResponse(createUser(payload));
    if (action === "placeBet") return jsonResponse(placeBet(payload));
    if (action === "settleBet") return jsonResponse(settleBet(payload));

    return jsonResponse({ statusCode: 404, error: "Unknown action." });
  } catch (error) {
    return jsonResponse({ statusCode: 400, error: "Google Sheets action failed.", detail: error.message });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheets() {
  ensureSheet(SHEETS.login, HEADERS.login);
  ensureSheet(SHEETS.users, HEADERS.users);
  ensureSheet(SHEETS.bets, HEADERS.bets);
  ensureSheet(SHEETS.rowStats, HEADERS.rowStats);
}

function ensureSheet(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map((value) => String(value || ""));
  if (sheet.getLastRow() === 0 || current.every((value) => !value)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sheet;
  }
  const missing = headers.filter((header) => !current.includes(header));
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function readRows(sheetName, headers) {
  const sheet = ensureSheet(sheetName, headers);
  const values = sheet.getDataRange().getValues();
  const actualHeaders = values[0].map((value) => String(value || ""));
  return values.slice(1).filter((row) => row.some((cell) => cell !== "")).map((row, index) => {
    const record = { _row: index + 2 };
    actualHeaders.forEach((header, col) => {
      if (header) record[header] = row[col];
    });
    return record;
  });
}

function appendRecord(sheetName, headers, record) {
  const sheet = ensureSheet(sheetName, headers);
  const actualHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((value) => String(value || ""));
  sheet.appendRow(actualHeaders.map((header) => record[header] ?? ""));
}

function writeRecord(sheetName, headers, rowNumber, record) {
  const sheet = ensureSheet(sheetName, headers);
  const actualHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((value) => String(value || ""));
  sheet.getRange(rowNumber, 1, 1, actualHeaders.length).setValues([actualHeaders.map((header) => record[header] ?? "")]);
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function updateRowStats(payload) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const eventId = String(payload.eventId || "").trim();
    if (!eventId) return { statusCode: 400, error: "Missing required field: eventId" };

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const existing = readRows(SHEETS.rowStats, HEADERS.rowStats);
    const byKey = {};
    existing.forEach((row) => byKey[`${row.eventId}::${row.rowKey}`] = row);

    rows.forEach((row) => {
      const rowKey = String(row.key || "").trim();
      if (!rowKey) return;
      const values = [toNumber(row.backPrice, null), toNumber(row.layPrice, null)].filter((value) => value !== null);
      if (values.length === 0) return;

      const key = `${eventId}::${rowKey}`;
      const current = byKey[key] || { eventId, rowKey, min: "", max: "", _row: null };
      const nowMin = Math.min(...values);
      const nowMax = Math.max(...values);
      const currentMin = toNumber(current.min, null);
      const currentMax = toNumber(current.max, null);
      current.min = currentMin === null ? nowMin : Math.min(currentMin, nowMin);
      current.max = currentMax === null ? nowMax : Math.max(currentMax, nowMax);
      current.updatedAt = new Date().toISOString();

      if (current._row) writeRecord(SHEETS.rowStats, HEADERS.rowStats, current._row, current);
      else {
        appendRecord(SHEETS.rowStats, HEADERS.rowStats, current);
        current._row = ensureSheet(SHEETS.rowStats, HEADERS.rowStats).getLastRow();
      }
      byKey[key] = current;
    });

    const stats = {};
    Object.values(byKey).filter((row) => String(row.eventId) === eventId).forEach((row) => {
      stats[row.rowKey] = { min: row.min, max: row.max };
    });
    return { eventId, fetchedAt: new Date().toISOString(), stats };
  } finally {
    lock.releaseLock();
  }
}

function publicLedger() {
  const users = readRows(SHEETS.users, HEADERS.users);
  const bets = readRows(SHEETS.bets, HEADERS.bets);
  const summary = users.map((user) => {
    const userBets = bets.filter((bet) => String(bet.username).toLowerCase() === String(user.username).toLowerCase());
    const pending = userBets.filter((bet) => bet.status === "PENDING");
    const settled = userBets.filter((bet) => bet.status === "SETTLED");
    return {
      username: user.username,
      name: user.name,
      balance: toNumber(user.balance, 0),
      totalStake: userBets.reduce((sum, bet) => sum + toNumber(bet.stake, 0), 0),
      exposure: pending.reduce((sum, bet) => sum + toNumber(bet.stake, 0), 0),
      pnl: settled.reduce((sum, bet) => sum + toNumber(bet.pnl, 0), 0),
      betCount: userBets.length
    };
  });

  return {
    users: users.map((user) => ({ username: user.username, name: user.name, role: user.role, balance: user.balance, createdAt: user.createdAt })),
    bets,
    summary
  };
}

function authUser(payload) {
  const username = String(payload.username || "").trim().toLowerCase();
  const password = String(payload.password || "");
  const user = readRows(SHEETS.users, HEADERS.users).find((row) => String(row.username).trim().toLowerCase() === username && String(row.password) === password);
  if (!user) return { statusCode: 401, error: "Invalid username or password." };
  return { user: { username: user.username, name: user.name, role: user.role, balance: user.balance } };
}

function createUser(payload) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    const name = String(payload.name || username).trim();
    const balance = Math.max(0, toNumber(payload.balance, 0));
    if (!username || !password) return { statusCode: 400, error: "Username and password are required." };

    const users = readRows(SHEETS.users, HEADERS.users);
    if (users.some((user) => String(user.username).toLowerCase() === username.toLowerCase())) {
      return { statusCode: 409, error: "User already exists." };
    }
    const loginRows = readRows(SHEETS.login, HEADERS.login);
    if (loginRows.some((user) => String(user.username).toLowerCase() === username.toLowerCase())) {
      return { statusCode: 409, error: "User already exists in Login Details." };
    }

    const user = { username, password, name, role: "user", balance, createdAt: new Date().toISOString() };
    appendRecord(SHEETS.users, HEADERS.users, user);
    appendRecord(SHEETS.login, HEADERS.login, { username, password, name, role: "user" });
    return { user: { username, name, role: "user", balance } };
  } finally {
    lock.releaseLock();
  }
}

function placeBet(payload) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const username = String(payload.username || "").trim();
    const stake = toNumber(payload.stake, null);
    const odds = toNumber(payload.odds, null);
    const isFancy = payload.marketType === "FANCY";
    const run = isFancy ? toNumber(payload.run || payload.target || payload.odds, "") : "";
    const target = isFancy ? toNumber(payload.target || payload.run || payload.odds, "") : "";
    const rate = isFancy ? toNumber(payload.rate, "") : "";
    const liability = toNumber(payload.liability, payload.marketType === "FANCY" ? fancyLiability(stake, rate, payload.side) : stake);
    if (!username || stake === null || stake <= 0 || odds === null || odds <= 0) {
      return { statusCode: 400, error: "Valid username, stake and odds are required." };
    }

    const users = readRows(SHEETS.users, HEADERS.users);
    const user = users.find((row) => String(row.username).toLowerCase() === username.toLowerCase());
    if (!user) return { statusCode: 404, error: "User not found in Google Sheet. Master must create the user first." };

    const balance = toNumber(user.balance, 0);
    if (balance < liability) return { statusCode: 400, error: "Insufficient balance." };

    user.balance = Number((balance - liability).toFixed(2));
    writeRecord(SHEETS.users, HEADERS.users, user._row, user);

    const bet = {
      id: Utilities.getUuid().replace(/-/g, "").slice(0, 12),
      username,
      eventId: payload.eventId,
      eventName: payload.eventName,
      marketKey: payload.marketKey,
      marketName: payload.marketName,
      marketType: payload.marketType,
      side: payload.side,
      odds,
      run,
      target,
      rate,
      stake,
      liability,
      estimatedProfit: payload.marketType === "FANCY" ? fancyProfit(stake, rate, payload.side) : betProfit(stake, odds),
      status: "PENDING",
      result: "",
      pnl: 0,
      placedAt: new Date().toISOString(),
      settledAt: "",
      statusAtSelection: payload.statusAtSelection,
      verifiedAt: payload.verifiedAt
    };
    appendRecord(SHEETS.bets, HEADERS.bets, bet);
    return { bet, ledger: publicLedger() };
  } finally {
    lock.releaseLock();
  }
}

function settleBet(payload) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const betId = String(payload.betId || "");
    const result = String(payload.result || "").toUpperCase();
    const bets = readRows(SHEETS.bets, HEADERS.bets);
    const bet = bets.find((row) => String(row.id) === betId);
    if (!bet) return { statusCode: 404, error: "Bet not found." };
    if (bet.status !== "PENDING") return { statusCode: 400, error: "Bet is already settled." };

    const users = readRows(SHEETS.users, HEADERS.users);
    const user = users.find((row) => String(row.username).toLowerCase() === String(bet.username).toLowerCase());
    const stake = toNumber(bet.stake, 0);
    const liability = toNumber(bet.liability, stake);
    const profit = toNumber(bet.estimatedProfit, 0);
    const balance = toNumber(user.balance, 0);

    if (result === "WIN") {
      bet.pnl = profit;
      user.balance = Number((balance + liability + profit).toFixed(2));
    } else if (result === "LOSE") {
      bet.pnl = -liability;
    } else if (result === "VOID") {
      bet.pnl = 0;
      user.balance = Number((balance + liability).toFixed(2));
    } else {
      return { statusCode: 400, error: "Result must be WIN, LOSE or VOID." };
    }

    bet.status = "SETTLED";
    bet.result = result;
    bet.settledAt = new Date().toISOString();
    writeRecord(SHEETS.users, HEADERS.users, user._row, user);
    writeRecord(SHEETS.bets, HEADERS.bets, bet._row, bet);
    return { bet, ledger: publicLedger() };
  } finally {
    lock.releaseLock();
  }
}
