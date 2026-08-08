# Kapruka Messenger Bot

An AI agent that replies to Facebook Messenger messages using OpenAI, with per-ad
product context and full logging pulled from/written to Google Sheets.

Serves 3 Facebook Pages from one server (Kapruka, Rapido, Gear Mart Sri Lanka).
WhatsApp is not wired up yet — see "What's not built yet" below.

## How it works

1. A customer messages one of the 3 Pages (often after clicking a Facebook ad).
2. Meta sends the message to `/webhook`. If they came from a Click-to-Messenger
   ad, Meta includes the ad's ID in a `referral` field on the first message.
3. The server looks up that ad ID in the **Ad_Product_Mapping** tab of the
   Google Sheet to get the product's details.
4. It calls OpenAI with the conversation history + that product context, and
   sends the reply back via the Messenger Send API.
5. Every incoming/outgoing message is logged to the **Conversations** tab, and
   the **Customers** tab is kept up to date per customer.

## Project layout

```
src/
  server.js              Express app: webhook verify + receive, wiring
  lib/googleSheets.js     Reads Ad_Product_Mapping, writes Conversations/Customers
  lib/openai.js           Builds the system prompt + calls OpenAI
  lib/meta.js              Multi-page token lookup + Messenger Send API
  lib/conversationStore.js In-memory recent-turn history per customer
.env                      All secrets/config (never commit this)
Kapruka_Chatbot_Data_Template.xlsx   Original template for the Google Sheet
```

## Setup

### 1. Install dependencies

```
npm install
```

### 2. Fill in `.env`

Most values are already filled in from what you provided. Still needed:

- **`GOOGLE_SHEETS_CREDS`** — a Google service account JSON (currently using
  an account from an older project; works fine as long as it's shared as
  Editor on the sheet, but consider creating a fresh one for this project
  eventually).
- The **spreadsheet must be shared** (Editor access) with the service
  account's `client_email` — you've done this already.

### 3. Run locally

```
npm start
```

You should see:

```
Server listening on port 3000
Configured Pages: [ '764176873446036', '109408748617460', '801459736379362' ]
```

### 4. Expose it publicly (for testing)

Meta needs a public HTTPS URL to send webhooks to. For local dev, use ngrok:

```
ngrok http 3000
```

Copy the `https://....ngrok-free.app` URL it gives you.

### 5. Register the webhook in Meta

For each Page's app (Meta App Dashboard → your app → Messenger → Settings):

- Callback URL: `https://<your-ngrok-url>/webhook`
- Verify Token: must match `VERIFY_TOKEN` in `.env` (`meta_webhook_secret_2025`)
- Subscribe to the `messages` and `messaging_referrals` webhook fields
- Under "Webhooks", subscribe each of the 3 Pages to this app

### 6. Test it

Message one of the 3 connected Facebook Pages. Check:

- Your terminal for logs
- The Google Sheet's **Conversations** tab for the logged messages
- The **Customers** tab for the new/updated customer row

## Ad → product context

For this to actually work per-ad, the **Ad_Product_Mapping** tab needs a row
for every ad you run, with the `ad_id` matching exactly what Meta sends. Get
the ad ID from Ads Manager (or design the ad as a Click-to-Messenger ad and
check the `referral.ad_id` field in your server logs the first time someone
clicks it, if you're unsure of the exact ID format).

If no ad context is found for a conversation, the bot still replies — it just
tells the customer it doesn't have specific product details and offers to
connect them with the team, rather than guessing.

## What's not built yet

- **WhatsApp** — the webhook already detects WhatsApp payloads
  (`object: "whatsapp_business_account"`) but doesn't process them yet. Needs
  a WhatsApp access token + phone number ID once you have WhatsApp Business
  API set up.
- **Sending images from the Google Drive folder link** — currently the bot
  only replies with text and mentions the Drive link exists; it doesn't
  actually attach/send the images via Messenger yet.
- **Real human handoff** — the bot is prompted to *offer* to escalate, but
  there's no actual notification to a human agent yet (e.g. Slack alert).
- **Webhook signature verification** (`X-Hub-Signature-256`) — recommended
  before going to production, to confirm requests genuinely come from Meta.
  Needs your Meta App Secret, which we don't have yet.

## Security reminder

Several live credentials were shared in this conversation and now live only
in your local `.env` file. Once everything's working end to end, rotate:

- OpenAI API key
- The 3 Meta Page access tokens
- The Google service account key (delete the old key, generate a new one)

`.env` is already git-ignored, so as long as you don't paste its contents
elsewhere, you're fine going forward.
