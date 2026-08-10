"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const googleSheets = require("../src/lib/googleSheets");
const googleDrive = require("../src/lib/googleDrive");
const productImagePipeline = require("../src/lib/productImagePipeline");

const app = express();
// Render assigns the port to bind to via PORT; DASHBOARD_PORT is only used
// for local dev, where PORT isn't set.
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3001;

const { DASHBOARD_USERNAME, DASHBOARD_PASSWORD } = process.env;
if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
  throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD must be set in .env before starting the dashboard.");
}

// This dashboard shows customer names/phones/addresses and can approve
// product images, so it's gated even for local use — required once this
// also runs as a public Render service, not just on localhost.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (user === DASHBOARD_USERNAME && pass === DASHBOARD_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Kapruka Dashboard"');
  res.status(401).send("Authentication required");
}

app.use(requireAuth);
app.use(express.json());
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

// Kicks off the Kapruka + Daraz image pipeline for one product code. Runs
// synchronously (can take ~30-90s due to the Daraz scraping step) — this is
// a local admin tool, not the live bot, so a blocking request is fine.
app.post("/api/products/:code/fetch-images", async (req, res) => {
  try {
    const summary = await productImagePipeline.fetchImagesForProduct(req.params.code);
    res.json(summary);
  } catch (err) {
    console.error("[dashboard] Failed to fetch images:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/image-review", async (req, res) => {
  try {
    const rows = await googleSheets.listImageReviews({
      status: req.query.status,
      productCode: req.query.productCode,
    });
    res.json(rows);
  } catch (err) {
    console.error("[dashboard] Failed to list image reviews:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/image-review/:reviewId/approve", async (req, res) => {
  try {
    const row = await googleSheets.getImageReview(req.params.reviewId);
    if (!row) return res.status(404).json({ error: "Review row not found" });

    const { pendingFolderId, officialFolderId } = await googleDrive.getProductFolders(row.product_code);
    await googleDrive.moveFile(row.drive_file_id, pendingFolderId, officialFolderId);
    await googleSheets.updateImageReviewStatus(req.params.reviewId, "Approved");
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] Failed to approve image:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/image-review/:reviewId/reject", async (req, res) => {
  try {
    const row = await googleSheets.getImageReview(req.params.reviewId);
    if (!row) return res.status(404).json({ error: "Review row not found" });

    await googleDrive.deleteFile(row.drive_file_id).catch(() => {});
    await googleSheets.updateImageReviewStatus(req.params.reviewId, "Rejected");
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] Failed to reject image:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
