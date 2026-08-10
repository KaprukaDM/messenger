"use strict";

/**
 * One-time setup script: authenticates as a real Google account (not the
 * Sheets service account) so the product image pipeline can upload into a
 * normal "My Drive" folder — no Google Workspace / Shared Drive required.
 *
 * Run once with `npm run drive-auth` after creating an OAuth client
 * (Desktop app type) in the messenger-bot-482114 GCP project and putting
 * its Client ID/Secret into .env. It opens a consent screen in your
 * browser, then prints a refresh token to paste into .env.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const { exec } = require("child_process");
const { google } = require("googleapis");

const PORT = 4321;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } = process.env;

if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
  console.error(
    "Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env.\n" +
      "Create an OAuth client (Application type: Desktop app) in the Google Cloud\n" +
      "console for project messenger-bot-482114, then add its Client ID and Secret\n" +
      "to .env before running this script."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive"],
});

console.log("\nOpen this URL and sign in with the Google account you want the bot to store images in:\n");
console.log(authUrl);
console.log("\nWaiting for you to approve access...\n");

exec(`start "" "${authUrl}"`, () => {}); // best-effort auto-open on Windows

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Access denied. You can close this tab.</h2>");
    console.error(`Google returned an error: ${error}`);
    server.close(() => process.exit(1));
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Success! You can close this tab and go back to the terminal.</h2>");

    console.log("Add this line to your .env file:\n");
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\nDone.");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end("<h2>Something went wrong exchanging the code — check the terminal.</h2>");
    console.error("Failed to exchange code for tokens:", err.message);
  } finally {
    server.close(() => process.exit(0));
  }
});

server.listen(PORT);
