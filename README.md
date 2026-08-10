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
  server.js                  Express app: webhook verify + receive, wiring
  lib/googleSheets.js        Reads Ad_Product_Mapping, writes Conversations/Customers/Orders/Image_Review
  lib/openai.js               Builds the system prompt + calls OpenAI
  lib/meta.js                  Multi-page token lookup + Messenger Send API
  lib/conversationStore.js     In-memory recent-turn history per customer
  lib/kaprukaMcp.js            Raw client for Kapruka's live MCP server (catalog/delivery/orders)
  lib/kaprukaTools.js          OpenAI tool definitions wrapping the MCP tools
  lib/googleDrive.js           Drive folder/upload helper for the product image pipeline
  lib/darazScraper.js          Puppeteer-based Daraz search + review-photo scraper
  lib/productImagePipeline.js  Orchestrates Kapruka + Daraz -> Drive -> Image_Review
dashboard/                  Local-only admin UI (chats monitor + product image review) — not deployed to Render
.env                       All secrets/config (never commit this)
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

## Product image pipeline (dashboard-triggered, not part of the live bot)

Name each ad after its Kapruka product code, and the dashboard's **Product
Images** tab can build a photo set for it automatically:

1. You click **Fetch Images** for a product code in the dashboard.
2. It pulls the official product photo straight from Kapruka's own catalog
   (via the MCP `kapruka_get_product` tool) and uploads it to Drive, auto-approved.
3. It searches Daraz for the same product by title and, if it finds a
   confident match, scrapes photos out of the customer reviews section and
   uploads them to a `pending_review` Drive subfolder.
4. Daraz photos **do not go live automatically** — they show up in the
   dashboard's pending grid for you to Approve/Reject, since they're
   customer-uploaded content with real licensing/ownership questions and the
   Daraz-side product match is a fuzzy title comparison, not a guaranteed
   exact match. Approving moves the file into the product's `official` Drive
   folder; rejecting deletes it.
5. Everything is tracked in a new **Image_Review** sheet tab.

### One-time Drive setup

Service accounts have no storage quota of their own, and this Google account
doesn't have Workspace (so no Shared Drives to work around that). Instead,
Drive uploads authenticate as a **real Google account** via OAuth:

1. Enable the **Google Drive API** on the Sheets project
   (`messenger-bot-482114`): [console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com)
2. In that same project, go to **APIs & Services → Credentials → Create
   Credentials → OAuth client ID**, Application type **Desktop app**. Copy the
   Client ID and Client Secret into `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`.
   - If prompted to configure the consent screen first: User type **External**,
     fill in the required fields, and add your own Google account under
     **Test users** (this keeps the app in "Testing" mode, which is fine —
     no Google review needed since only you'll ever sign in).
3. Run `npm run drive-auth`. It opens a browser consent screen — sign in with
   the Google account you want images stored in, approve access, then copy
   the `GOOGLE_OAUTH_REFRESH_TOKEN` line it prints into `.env`.
4. In Google Drive, create a normal folder (e.g. "Kapruka Product Images")
   in that account's My Drive, open it, and copy its ID from the URL
   (`drive.google.com/drive/folders/<THIS PART>`) into `DRIVE_ROOT_FOLDER_ID`.

This pipeline only runs locally via `npm run dashboard` — it's not deployed
to Render and never runs automatically.

## What's not built yet

- **WhatsApp** — the webhook already detects WhatsApp payloads
  (`object: "whatsapp_business_account"`) but doesn't process them yet. Needs
  a WhatsApp access token + phone number ID once you have WhatsApp Business
  API set up.
- **Sending the approved Drive images to customers via Messenger** — the
  product image pipeline above gets approved photos into Drive, but the bot
  itself still only mentions the Drive link in text; it doesn't attach the
  actual images to a Messenger reply yet.
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
