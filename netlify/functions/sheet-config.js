const SHEET_ID = "1pQQ6IedQjTdEAkfGjG7cGFFge5KXLrsDyTGKT56MevI";
const SHEET_NAMES = {
  login: "Login Details",
  events: "Events"
};

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

  return parseGvizResponse(await response.text());
}

exports.handler = async () => {
  try {
    const [loginRows, eventRows] = await Promise.all([
      fetchSheetRows(SHEET_NAMES.login),
      fetchSheetRows(SHEET_NAMES.events)
    ]);

    return json(200, {
      fetchedAt: new Date().toISOString(),
      loginRows,
      eventRows
    });
  } catch (error) {
    return json(502, {
      error: "Unable to load Google Sheet configuration.",
      detail: error.message
    });
  }
};
