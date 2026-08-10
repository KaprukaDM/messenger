"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const express = require("express");
const googleSheets = require("../src/lib/googleSheets");
const googleDrive = require("../src/lib/googleDrive");
const productImagePipeline = require("../src/lib/productImagePipeline");
const openai = require("../src/lib/openai");
const meta = require("../src/lib/meta");

const DEFAULT_AGENT_PROMPT_PATH = path.join(__dirname, "..", "prompts", "agent.md");

const app = express();
// DASHBOARD_PORT takes priority so local dev doesn't collide with the bot's
// PORT=3000 (both read the same .env) — falls back to PORT for Render,
// where this service gets its own PORT independent of the bot's service.
const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3001;

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

// Sends a message to the customer as a human team member — used from the
// Escalated tab to actually take over a conversation. Logged as handledBy
// "Human" so it's visually distinct from bot replies in the thread.
app.post("/api/customers/:id/reply", async (req, res) => {
  try {
    const { text } = req.body;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const customer = await googleSheets.getCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    if (!customer.page_id) {
      return res.status(400).json({ error: "No page_id on record for this customer — can't reply (they messaged before this feature existed)." });
    }

    await meta.sendMessengerText(customer.page_id, req.params.id, text);
    await googleSheets.logMessage({
      platform: customer.platform || "Facebook",
      customerId: req.params.id,
      customerName: customer.name,
      adId: customer.last_ad_id,
      direction: "Outgoing",
      messageText: text,
      handledBy: "Human",
    });
    // A human just took over — stop the bot from also auto-replying to this
    // customer until the conversation is marked resolved.
    await googleSheets.setBotPaused(req.params.id, true);
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] Failed to send human reply:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/customers/:id/resolve", async (req, res) => {
  try {
    await googleSheets.markCustomerResolved(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] Failed to resolve customer:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders", async (_req, res) => {
  try {
    const orders = await googleSheets.listOrders();
    res.json(orders);
  } catch (err) {
    console.error("[dashboard] Failed to list orders:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders/:orderId/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (typeof status !== "string" || !status.trim()) {
      return res.status(400).json({ error: "status is required" });
    }
    await googleSheets.updateOrderStatus(req.params.orderId, status);
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] Failed to update order status:", err);
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

// The bot's editable persona/rules. Saved to the Agent_Config sheet (not a
// local file) so this dashboard and the live bot — separate Render
// deployments with separate filesystems — share one source of truth.
app.get("/api/agent-prompt", async (_req, res) => {
  try {
    const saved = await googleSheets.getAgentPrompt();
    const prompt = saved || fs.readFileSync(DEFAULT_AGENT_PROMPT_PATH, "utf8");
    res.json({ prompt, isSaved: Boolean(saved) });
  } catch (err) {
    console.error("[dashboard] Failed to load agent prompt:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent-prompt", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }
    await googleSheets.saveAgentPrompt(prompt);
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] Failed to save agent prompt:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/agent-prompt-history", async (_req, res) => {
  try {
    const history = await googleSheets.listAgentPromptHistory(20);
    res.json(history);
  } catch (err) {
    console.error("[dashboard] Failed to load agent prompt history:", err);
    res.status(500).json({ error: err.message });
  }
});

// Product/ad list for the Test Bot tab's context picker.
app.get("/api/ad-mapping", async (_req, res) => {
  try {
    const map = await googleSheets.loadAdMapping();
    res.json(Array.from(map.values()));
  } catch (err) {
    console.error("[dashboard] Failed to load ad mapping:", err);
    res.status(500).json({ error: err.message });
  }
});

// Runs the real bot logic (same generateReply as production) against a
// scratch conversation — nothing here is logged to Conversations/Customers
// or sent anywhere, so it's safe to experiment with freely.
app.post("/api/test-chat", async (req, res) => {
  try {
    const { history, adId } = req.body;
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: "history array is required" });
    }
    const productContext = adId ? await googleSheets.getProductContextByAdId(adId) : null;
    const result = await openai.generateReply({ history, productContext });
    res.json(result);
  } catch (err) {
    console.error("[dashboard] Failed to run test chat:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
