"use strict";

const { google } = require("googleapis");
const { Readable } = require("stream");

// Folder in your regular Google Drive ("My Drive") that everything this
// module creates lives under, one subfolder per Kapruka product code.
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;

// Drive uploads authenticate as a real Google account (via OAuth + a
// refresh token from the one-time `npm run drive-auth` flow), NOT the
// Sheets service account — service accounts have no storage quota of their
// own and this account doesn't have Google Workspace (so no Shared Drives
// to work around that). See README.md "Product image pipeline" setup.
let driveClient = null;

function getClient() {
  if (driveClient) return driveClient;

  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error(
      "Google OAuth env vars are missing — run `npm run drive-auth` once and fill in the values it prints."
    );
  }

  const auth = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });

  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

/** Finds a child folder by exact name under parentId, or creates it. */
async function findOrCreateFolder(name, parentId) {
  if (!parentId) {
    throw new Error("DRIVE_ROOT_FOLDER_ID is not set in .env — see setup instructions.");
  }
  const drive = getClient();

  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  return created.data.id;
}

/**
 * Ensures {ROOT}/{productCode}/pending_review and {ROOT}/{productCode}/official
 * exist, returns their folder IDs.
 */
async function getProductFolders(productCode) {
  const productFolderId = await findOrCreateFolder(productCode, ROOT_FOLDER_ID);
  const [pendingFolderId, officialFolderId] = await Promise.all([
    findOrCreateFolder("pending_review", productFolderId),
    findOrCreateFolder("official", productFolderId),
  ]);
  return { productFolderId, pendingFolderId, officialFolderId };
}

/**
 * Uploads a downloaded image buffer into a folder and makes it viewable by
 * anyone with the link (needed later so Messenger's Send API can fetch it
 * by URL). Returns { fileId, viewUrl, directUrl }.
 */
async function uploadImage({ parentId, filename, mimeType, buffer }) {
  const drive = getClient();

  const created = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id, webViewLink",
  });

  const fileId = created.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });

  return {
    fileId,
    viewUrl: `https://drive.google.com/file/d/${fileId}/view`,
    directUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
  };
}

/** Moves a file from one folder to another (used when an image is approved). */
async function moveFile(fileId, fromFolderId, toFolderId) {
  const drive = getClient();
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: "id, parents",
  });
}

async function deleteFile(fileId) {
  const drive = getClient();
  await drive.files.delete({ fileId });
}

module.exports = {
  getProductFolders,
  uploadImage,
  moveFile,
  deleteFile,
};
