"use strict";

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

const TAB_AD_MAPPING = "Ad_Product_Mapping";
const TAB_CONVERSATIONS = "Conversations";
const TAB_CUSTOMERS = "Customers";
const TAB_ORDERS = "Orders";
const ORDERS_HEADERS = [
  "order_id", "timestamp", "customer_id", "platform", "ad_id",
  "product_name", "customer_name", "phone", "address", "status", "notes",
];

const TAB_IMAGE_REVIEW = "Image_Review";
const IMAGE_REVIEW_HEADERS = [
  "review_id", "timestamp", "product_code", "product_name", "source",
  "image_url", "drive_file_id", "status",
];

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;

  const raw = process.env.GOOGLE_SHEETS_CREDS;
  if (!raw) {
    throw new Error("GOOGLE_SHEETS_CREDS is not set in .env");
  }
  const credentials = JSON.parse(raw);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/**
 * In-memory cache of Ad_Product_Mapping, keyed by ad_id.
 * Refreshed on a timer so we don't hit the Sheets API on every message.
 */
let adMapCache = new Map();
let adMapLoadedAt = 0;
const AD_MAP_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadAdMapping(force = false) {
  const now = Date.now();
  if (!force && adMapCache.size > 0 && now - adMapLoadedAt < AD_MAP_TTL_MS) {
    return adMapCache;
  }

  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_AD_MAPPING}!A:I`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    adMapCache = new Map();
    adMapLoadedAt = now;
    return adMapCache;
  }

  const headers = rows[0].map((h) => String(h).trim());
  const map = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue; // skip blank ad_id rows
    const record = {};
    headers.forEach((h, idx) => {
      record[h] = row[idx] !== undefined ? row[idx] : "";
    });
    map.set(String(record.ad_id).trim(), record);
  }

  adMapCache = map;
  adMapLoadedAt = now;
  return adMapCache;
}

/** Look up product context for a given ad_id. Returns null if not found. */
async function getProductContextByAdId(adId) {
  if (!adId) return null;
  const map = await loadAdMapping();
  return map.get(String(adId).trim()) || null;
}

async function appendRow(tabName, values) {
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A:Z`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let messageCounter = 0;
function nextMessageId() {
  messageCounter += 1;
  return `MSG-${Date.now()}-${messageCounter}`;
}

/**
 * Log one message (incoming or outgoing) to the Conversations tab.
 */
async function logMessage({
  platform,
  customerId,
  customerName,
  adId,
  direction,
  messageText,
  detectedIntent = "",
  handledBy = "Bot",
  escalated = "No",
  notes = "",
}) {
  await appendRow(TAB_CONVERSATIONS, [
    nextMessageId(),
    nowIso(),
    platform,
    customerId,
    customerName || "",
    adId || "",
    direction,
    messageText,
    detectedIntent,
    handledBy,
    escalated,
    notes,
  ]);
}

/**
 * Find an existing Customers row by customer_id. Returns { rowNumber, record } or null.
 * rowNumber is 1-indexed as used by the Sheets API (row 1 = header).
 */
async function findCustomerRow(customerId) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_CUSTOMERS}!A:J`,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === customerId) {
      return { rowNumber: i + 1, record: rows[i] };
    }
  }
  return null;
}

/**
 * Create or update a Customers row: bumps last_contact_date, total_messages,
 * last_ad_id.
 */
async function upsertCustomer({ customerId, name, platform, adId }) {
  const sheets = getClient();
  const today = nowIso().slice(0, 10);
  const existing = await findCustomerRow(customerId);

  if (!existing) {
    await appendRow(TAB_CUSTOMERS, [
      customerId,
      name || "",
      platform,
      customerId,
      today,
      today,
      adId || "",
      1,
      "Active",
      "",
    ]);
    return;
  }

  const record = existing.record;
  const totalMessages = (parseInt(record[7], 10) || 0) + 1;
  const updated = [
    record[0],
    name || record[1] || "",
    record[2] || platform,
    record[3] || customerId,
    record[4] || today, // keep original first_contact_date
    today, // last_contact_date
    adId || record[6] || "",
    totalMessages,
    record[8] || "Active",
    record[9] || "",
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_CUSTOMERS}!A${existing.rowNumber}:J${existing.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [updated] },
  });
}

/**
 * Mark a customer's status as "Escalated" — called after generating a reply
 * that the AI flagged as needing a human. Only touches the status column.
 */
async function markCustomerEscalated(customerId) {
  const sheets = getClient();
  const existing = await findCustomerRow(customerId);
  if (!existing) return; // upsertCustomer should have created the row already

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_CUSTOMERS}!I${existing.rowNumber}:I${existing.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [["Escalated"]] },
  });
}

/**
 * Reload the most recent messages for a customer from the Conversations tab.
 * Used to restore chat memory after a server restart (e.g. Render free tier
 * spinning down between messages), since the in-memory conversation buffer
 * doesn't survive that.
 */
async function getRecentHistory(customerId, limit = 20) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_CONVERSATIONS}!A:L`,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h).trim());
  const idxCustomer = headers.indexOf("customer_id");
  const idxDirection = headers.indexOf("direction");
  const idxText = headers.indexOf("message_text");
  if (idxCustomer === -1 || idxDirection === -1 || idxText === -1) return [];

  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[idxCustomer] === customerId && row[idxText]) {
      matches.push({
        role: row[idxDirection] === "Incoming" ? "user" : "assistant",
        content: row[idxText],
      });
    }
  }

  return matches.slice(-limit);
}

function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] !== undefined ? row[idx] : "";
    });
    return obj;
  });
}

/**
 * List all customers (for the monitoring dashboard), most recently
 * contacted first.
 */
async function listCustomers() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_CUSTOMERS}!A:J`,
  });

  const customers = rowsToObjects(res.data.values || []).filter((c) => c.customer_id);
  customers.sort((a, b) => (b.last_contact_date || "").localeCompare(a.last_contact_date || ""));
  return customers;
}

/**
 * List the full message thread for one customer, chronological order
 * (for the monitoring dashboard).
 */
async function listMessagesForCustomer(customerId) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_CONVERSATIONS}!A:L`,
  });

  return rowsToObjects(res.data.values || []).filter((m) => m.customer_id === customerId);
}

let ordersTabReady = false;

/**
 * Create the Orders tab (with headers) if it doesn't exist yet — so there's
 * no manual sheet-setup step for this feature. Safe to call repeatedly.
 */
async function ensureOrdersTabExists() {
  if (ordersTabReady) return;

  const sheets = getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === TAB_ORDERS
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_ORDERS } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_ORDERS}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [ORDERS_HEADERS] },
    });
  }

  ordersTabReady = true;
}

let orderCounter = 0;
function nextOrderId() {
  orderCounter += 1;
  return `ORD-${Date.now()}-${orderCounter}`;
}

/**
 * Record a manually-placed order (customer gave name/phone/address in
 * chat) — separate from Kapruka's own order system, this is for ad-driven
 * products the team fulfills directly.
 */
async function logOrder({
  customerId,
  platform,
  adId,
  productName,
  customerName,
  phone,
  address,
  notes = "",
}) {
  await ensureOrdersTabExists();
  await appendRow(TAB_ORDERS, [
    nextOrderId(),
    nowIso(),
    customerId,
    platform,
    adId || "",
    productName || "",
    customerName || "",
    phone || "",
    address || "",
    "New",
    notes,
  ]);
}

let imageReviewTabReady = false;

/**
 * Create the Image_Review tab (with headers) if it doesn't exist yet.
 * Safe to call repeatedly.
 */
async function ensureImageReviewTabExists() {
  if (imageReviewTabReady) return;

  const sheets = getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === TAB_IMAGE_REVIEW
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_IMAGE_REVIEW } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_IMAGE_REVIEW}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [IMAGE_REVIEW_HEADERS] },
    });
  }

  imageReviewTabReady = true;
}

let imageReviewCounter = 0;
function nextImageReviewId() {
  imageReviewCounter += 1;
  return `IMG-${Date.now()}-${imageReviewCounter}`;
}

/**
 * Record one candidate image (official Kapruka photo or a scraped Daraz
 * review photo) awaiting your approve/reject decision in the dashboard.
 */
async function addImageReviewRow({ productCode, productName, source, imageUrl, driveFileId }) {
  await ensureImageReviewTabExists();
  const reviewId = nextImageReviewId();
  await appendRow(TAB_IMAGE_REVIEW, [
    reviewId,
    nowIso(),
    productCode,
    productName || "",
    source,
    imageUrl,
    driveFileId,
    "Pending",
  ]);
  return reviewId;
}

/** All Image_Review rows, optionally filtered by status and/or product code. */
async function listImageReviews({ status, productCode } = {}) {
  await ensureImageReviewTabExists();
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_IMAGE_REVIEW}!A:H`,
  });

  let rows = rowsToObjects(res.data.values || []).filter((r) => r.review_id);
  if (status) rows = rows.filter((r) => r.status === status);
  if (productCode) rows = rows.filter((r) => r.product_code === productCode);
  return rows;
}

/** Fetches a single Image_Review row by ID, or null if not found. */
async function getImageReview(reviewId) {
  const rows = await listImageReviews();
  return rows.find((r) => r.review_id === reviewId) || null;
}

/** Updates the status column (Approved/Rejected) for one review row by ID. */
async function updateImageReviewStatus(reviewId, status) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_IMAGE_REVIEW}!A:H`,
  });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex((row) => row[0] === reviewId);
  if (rowIndex === -1) throw new Error(`Image review row not found: ${reviewId}`);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_IMAGE_REVIEW}!H${rowIndex + 1}:H${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}

module.exports = {
  getProductContextByAdId,
  loadAdMapping,
  logMessage,
  upsertCustomer,
  markCustomerEscalated,
  getRecentHistory,
  listCustomers,
  listMessagesForCustomer,
  logOrder,
  addImageReviewRow,
  listImageReviews,
  getImageReview,
  updateImageReviewStatus,
};
