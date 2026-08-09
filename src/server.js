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

  // Fetch the customer's real name once per process (cached after that) so
  // the dashboard shows a name instead of a raw PSID.
  let customerName = conversationStore.getName(psid);
  if (!customerName) {
    customerName = await meta.getUserProfile(pageId, psid).catch(() => null);
    if (customerName) conversationStore.setName(psid, customerName);
  }

  // Log the incoming message + update the customer record.
  await Promise.all([
    googleSheets.logMessage({
      platform: "Facebook",
      customerId: psid,
      customerName,
      adId,
      direction: "Incoming",
      messageText: text,
    }),
    googleSheets.upsertCustomer({
      customerId: psid,
      name: customerName,
      platform: "Facebook",
      adId,
    }),
  ]).catch((err) => console.error("[sheets] Failed to log incoming message:", err));

  // Restore memory from the durable log if this process doesn't have it
  // in-memory yet (e.g. Render's free tier just woke back up).
  if (conversationStore.getHistory(psid).length === 0) {
    const priorHistory = await googleSheets
      .getRecentHistory(psid)
      .catch((err) => {
        console.error("[sheets] Failed to restore history:", err);
        return [];
      });
    conversationStore.seedHistoryIfEmpty(psid, priorHistory);
  }

  conversationStore.addTurn(psid, "user", text);

  // A new message means any pending "would you like to order?" follow-up
  // from before is stale - the conversation has moved on.
  conversationStore.clearPendingClose(psid);

  // Ad-triggered conversations get fast, pre-loaded product context.
  // Everything else gets live Kapruka MCP tools (search, delivery, order tracking).
  let result;
  let productContext = null;
  if (adId) {
    productContext = await googleSheets.getProductContextByAdId(adId);
    result = await openai.generateReply({
      history: conversationStore.getHistory(psid),
      productContext,
    });
  } else {
    result = await openai.generateReplyWithTools({
      history: conversationStore.getHistory(psid),
    });
  }

  const { text: reply, escalated, offerClose, orderInfo } = result;

  if (!reply) {
    console.warn("[openai] Empty reply generated for", psid);
    return;
  }

  conversationStore.addTurn(psid, "assistant", reply);

  console.log(
    `[messenger] Replying to ${psid}: ${reply}${escalated ? " [ESCALATED]" : ""}${offerClose ? " [OFFER_CLOSE queued]" : ""}`
  );

  await meta.sendMessengerText(pageId, psid, reply);

  await googleSheets
    .logMessage({
      platform: "Facebook",
      customerId: psid,
      customerName,
      adId,
      direction: "Outgoing",
      messageText: reply,
      escalated: escalated ? "Yes" : "No",
    })
    .catch((err) => console.error("[sheets] Failed to log outgoing message:", err));

  if (escalated) {
    await googleSheets
      .markCustomerEscalated(psid)
      .catch((err) => console.error("[sheets] Failed to mark customer escalated:", err));
  }

  if (orderInfo) {
    await googleSheets
      .logOrder({
        customerId: psid,
        platform: "Facebook",
        adId,
        productName: productContext ? productContext.product_name : "",
        customerName: orderInfo.name,
        phone: orderInfo.phone,
        address: orderInfo.address,
      })
      .catch((err) => console.error("[sheets] Failed to log order:", err));
  }

  if (offerClose) {
    const timeoutHandle = setTimeout(() => {
      sendClosingFollowUp(pageId, psid).catch((err) =>
        console.error("[messenger] Failed to send closing follow-up:", err)
      );
    }, 20000);
    conversationStore.setPendingClose(psid, timeoutHandle);
  }
}

/**
 * Sends the "would you like to order?" follow-up ~20s after a reply that
 * signaled OFFER_CLOSE, mimicking a human agent checking back in rather
 * than cramming the question into the same message.
 */
async function sendClosingFollowUp(pageId, psid) {
  const history = conversationStore.getHistory(psid);
  const closingQuestion = openai.getClosingQuestion(history);

  conversationStore.addTurn(psid, "assistant", closingQuestion);
  console.log(`[messenger] Sending closing follow-up to ${psid}: ${closingQuestion}`);

  await meta.sendMessengerText(pageId, psid, closingQuestion);

  await googleSheets
    .logMessage({
      platform: "Facebook",
      customerId: psid,
      customerName: conversationStore.getName(psid),
      adId: conversationStore.getAdId(psid),
      direction: "Outgoing",
      messageText: closingQuestion,
      notes: "closing follow-up",
    })
    .catch((err) => console.error("[sheets] Failed to log closing follow-up:", err));
}

// ---------------------------------------------------------------------------
// Render sets RENDER_GIT_COMMIT automatically for git-deployed services, so
// this tells us exactly which commit is actually live - no more guessing
// whether a fix has been deployed yet.
const DEPLOYED_COMMIT = process.env.RENDER_GIT_COMMIT
  ? process.env.RENDER_GIT_COMMIT.slice(0, 7)
  : "local";

app.get("/", (_req, res) => {
  res.send(`Kapruka Messenger bot is running. (commit: ${DEPLOYED_COMMIT})`);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (commit: ${DEPLOYED_COMMIT})`);
  console.log("Configured Pages:", meta.listConfiguredPageIds());
});
