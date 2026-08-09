"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const googleSheets = require("../src/lib/googleSheets");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/customers", async (_req, res) => {
  try {
    const customers = await googleSheets.listCustomers();
    res.json(customers);
  } catch (err) {
    console.error("[dashboard] Failed to list customers:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/customers/:id/messages", async (req, res) => {
  try {
    const messages = await googleSheets.listMessagesForCustomer(req.params.id);
    res.json(messages);
  } catch (err) {
    console.error("[dashboard] Failed to list messages:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log("(Local monitoring tool only — not deployed to Render.)");
});
