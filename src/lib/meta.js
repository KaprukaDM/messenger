"use strict";

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v24.0";

/**
 * Build a { pageId -> accessToken } map from PAGE_ID_n / PAGE_ACCESS_TOKEN_n
 * pairs in the environment, so one bot can serve multiple Facebook Pages.
 */
function loadPageTokenMap() {
  const map = new Map();
  let i = 1;
  while (process.env[`PAGE_ID_${i}`]) {
    const pageId = process.env[`PAGE_ID_${i}`];
    const token = process.env[`PAGE_ACCESS_TOKEN_${i}`];
    if (pageId && token) {
      map.set(pageId, token);
    }
    i += 1;
  }
  return map;
}

const pageTokenMap = loadPageTokenMap();

function getPageAccessToken(pageId) {
  return pageTokenMap.get(pageId) || null;
}

function listConfiguredPageIds() {
  return Array.from(pageTokenMap.keys());
}

/**
 * Send a plain text message to a Messenger user via the Send API.
 * @param {string} pageId - which Page is sending (selects the right token)
 * @param {string} recipientPsid - the customer's page-scoped user ID
 * @param {string} text
 */
async function sendMessengerText(pageId, recipientPsid, text) {
  const token = getPageAccessToken(pageId);
  if (!token) {
    throw new Error(`No access token configured for Page ID ${pageId}`);
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: { text },
      messaging_type: "RESPONSE",
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Messenger send failed (${res.status}): ${errBody}`);
  }

  return res.json();
}

/**
 * Send a single image as a Messenger attachment via the Send API. The URL
 * must be directly fetchable image bytes (not an HTML "view" page) since
 * Facebook fetches it server-side.
 * @param {string} pageId
 * @param {string} recipientPsid
 * @param {string} imageUrl
 */
async function sendMessengerImage(pageId, recipientPsid, imageUrl) {
  const token = getPageAccessToken(pageId);
  if (!token) {
    throw new Error(`No access token configured for Page ID ${pageId}`);
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: {
        attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } },
      },
      messaging_type: "RESPONSE",
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Messenger image send failed (${res.status}): ${errBody}`);
  }

  return res.json();
}

/**
 * Fetch a Messenger user's display name via the Graph API user profile
 * endpoint. Returns null on any failure (missing permission, deleted
 * account, etc.) rather than throwing — a missing name shouldn't break
 * message handling.
 * @param {string} pageId - which Page's token to use
 * @param {string} psid - the customer's page-scoped user ID
 */
async function getUserProfile(pageId, psid) {
  const token = getPageAccessToken(pageId);
  if (!token) return null;

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
    return name || null;
  } catch (err) {
    console.error("[meta] Failed to fetch user profile:", err);
    return null;
  }
}

module.exports = {
  getPageAccessToken,
  listConfiguredPageIds,
  sendMessengerText,
  sendMessengerImage,
  getUserProfile,
};
