"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const googleSheets = require("../src/lib/googleSheets");
const googleDrive = require("../src/lib/googleDrive");
const productImagePipeline = require("../src/lib/productImagePipeline");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

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
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log("(Local monitoring tool only — not deployed to Render.)");
});
