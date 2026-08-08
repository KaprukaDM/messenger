"use strict";

require("dotenv").config();

const express = require("express");
const googleSheets = require("./lib/googleSheets");
const openai = require("./lib/openai");
const meta = require("./lib/meta");
const conversationStore = require("./lib/conversationStore");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ---------------------------------------------------------------------------
// Webhook verification (Meta calls this once when you set up the webhook URL)
// ---------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] Verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("[webhook] Verification failed — token mismatch.");
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// Incoming events (Messenger for now; WhatsApp will branch on req.body.object)
// ---------------------------------------------------------------------------
app.post("/webhook", (req, res) => {
  const body = req.body;

  // Acknowledge immediately so Meta doesn't retry/timeout while we call
  // OpenAI + Sheets. Actual processing continues after the response.
  res.sendStatus(200);

  if (body.object === "page") {
    handleMessengerPayload(body).catch((err) => {
      console.error("[webhook] Error handling Messenger payload:", err);
    });
  } else if (body.object === "whatsapp_business_account") {
    console.log(
      "[webhook] Received a WhatsApp event, but WhatsApp handling isn't wired up yet."
    );
  } else {
    console.warn("[webhook] Unrecognized payload object:", body.object);
  }
});

async function handleMessengerPayload(body) {
  for (const entry of body.entry || []) {
    const pageId = entry.id;

    for (const event of entry.messaging || []) {
      try {
        await handleMessengerEvent(pageId, event);
      } catch (err) {
        console.error("[messenger] Failed to handle event:", err, event);
      }
    }
  }
}

async function handleMessengerEvent(pageId, event) {
  const psid = event.sender && event.sender.id;
  if (!psid) return;

  // Skip echoes of our own outgoing messages, delivery/read receipts, etc.
  if (event.message && event.message.is_echo) return;

  // Ad attribution: Meta includes a `referral` object on the first message
  // (or a standalone referral event) when the customer arrives from a
  // Click-to-Messenger ad.
  const referral = event.referral || (event.message && event.message.referral);
  const adIdFromReferral = referral && (referral.ad_id || referral.source);
  if (adIdFromReferral) {
    conversationStore.setAdId(psid, String(adIdFromReferral));
  }
  const adId = conversationStore.getAdId(psid);

  // Only handle actual text messages for now (no attachments/postbacks yet).
  const text = event.message && event.message.text;
  if (!text) return;

  console.log(`[messenger] Incoming from ${psid} (page ${pageId})${adId ? ` [ad:${adId}]` : ""}: ${text}`);

  const productContext = await googleSheets.getProductContextByAdId(adId);

  // Log the incoming message + update the customer record.
  await Promise.all([
    googleSheets.logMessage({
      platform: "Facebook",
      customerId: psid,
      adId,
      direction: "Incoming",
      messageText: text,
    }),
    googleSheets.upsertCustomer({
      customerId: psid,
      platform: "Facebook",
      adId,
    }),
  ]).catch((err) => console.error("[sheets] Failed to log incoming message:", err));

  conversationStore.addTurn(psid, "user", text);

  const reply = await openai.generateReply({
    history: conversationStore.getHistory(psid),
    productContext,
  });

  if (!reply) {
    console.warn("[openai] Empty reply generated for", psid);
    return;
  }

  conversationStore.addTurn(psid, "assistant", reply);

  console.log(`[messenger] Replying to ${psid}: ${reply}`);

  await meta.sendMessengerText(pageId, psid, reply);

  await googleSheets
    .logMessage({
      platform: "Facebook",
      customerId: psid,
      adId,
      direction: "Outgoing",
      messageText: reply,
    })
    .catch((err) => console.error("[sheets] Failed to log outgoing message:", err));
}

// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send("Kapruka Messenger bot is running.");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Configured Pages:", meta.listConfiguredPageIds());
});
