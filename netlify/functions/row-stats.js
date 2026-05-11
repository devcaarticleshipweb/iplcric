const { runSheetsAction } = require("./sheets-backed");

exports.handler = (event) => runSheetsAction(event, "rowStats");
