"use strict";

/**
 * One-button pipeline (triggered from the dashboard, not the live bot):
 * given a Kapruka product code —
 *   1. pull the official product photo from Kapruka's own catalog (via MCP)
 *      and file it straight into Drive as auto-approved
 *   2. search Daraz for the same product and pull customer-review photos
 *      into a "pending_review" Drive folder for you to approve/reject
 *      in the dashboard before they're used anywhere customer-facing
 */

const kaprukaMcp = require("./kaprukaMcp");
const googleDrive = require("./googleDrive");
const googleSheets = require("./googleSheets");
const darazScraper = require("./darazScraper");

const IMAGE_URL_RE = /https?:\/\/\S+?\.(?:jpg|jpeg|png|webp)\b/gi;

function parseKaprukaProduct(markdown) {
  const titleMatch = markdown.match(/^##\s+(.+)$/m);
  const urlMatch = markdown.match(/\[View on Kapruka\]\(([^)]+)\)/);
  const images = Array.from(new Set(markdown.match(IMAGE_URL_RE) || []));

  if (!titleMatch) return null;
  return {
    name: titleMatch[1].trim(),
    url: urlMatch ? urlMatch[1] : null,
    images,
  };
}

/**
 * Kapruka's search sometimes returns zero results for a long, exact product
 * name (e.g. "Ikea Rinnig Kitchen Utensil Rack" -> nothing) even though a
 * shorter slice of the same name matches fine ("Ikea Rinnig" -> the exact
 * product). Retries with progressively shorter word-prefixes before giving
 * up, since callers (the model re-searching a product it only knows by its
 * full name from earlier context) can't be relied on to always guess a
 * shorter query themselves.
 */
async function findProductIdByName(query) {
  const words = query.trim().split(/\s+/);
  const attempts = [query];
  if (words.length > 3) attempts.push(words.slice(0, 3).join(" "));
  if (words.length > 2) attempts.push(words.slice(0, 2).join(" "));

  for (const q of attempts) {
    // limit: 1 is unreliable on Kapruka's search — it silently returns zero
    // results for queries that limit: 3+ resolves fine (verified empirically,
    // not just theorized) — so ask for a few instead of just the top one.
    const searchText = await kaprukaMcp.callTool("kapruka_search_products", { q, limit: 3 });
    const entries = [...searchText.matchAll(/\*\*\d+\.\s+(.+?)\*\*\s*\n\s*ID:\s*`([^`]+)`/g)];
    if (entries.length === 0) continue;

    // Kapruka's relevance ranking doesn't always put an exact name match
    // first (e.g. "Kitchen Rack" ranked below "Ikea Rinnig Kitchen Utensil
    // Rack") — prefer an exact (case-insensitive) title match if one is
    // present among the results, rather than blindly taking the top hit.
    const exact = entries.find(([, title]) => title.trim().toLowerCase() === query.trim().toLowerCase());
    return (exact || entries[0])[2];
  }
  return null;
}

async function resolveKaprukaProduct(productCode) {
  const text = await kaprukaMcp.callTool("kapruka_get_product", { product_id: productCode });
  const parsed = parseKaprukaProduct(text);
  if (parsed) return parsed;

  // Product ID didn't resolve directly — fall back to a keyword search.
  const productId = await findProductIdByName(productCode);
  if (!productId) return null;

  const retryText = await kaprukaMcp.callTool("kapruka_get_product", { product_id: productId });
  return parseKaprukaProduct(retryText);
}

/**
 * Fuller parse of the same kapruka_get_product markdown used above, for the
 * dashboard's Product Details tab — pulls out the fields Ad_Product_Mapping
 * actually stores (name/category/price/description/url), not just images.
 */
function parseKaprukaProductDetails(markdown) {
  const titleMatch = markdown.match(/^##\s+(.+)$/m);
  if (!titleMatch) return null;

  const priceMatch = markdown.match(/\*\*Price\*\*:\s*LKR\s*([\d,]+)/);
  const categoryMatch = markdown.match(/\*\*Category\*\*:\s*(.+)$/m);
  const urlMatch = markdown.match(/\[View on Kapruka\]\(([^)]+)\)/);
  const images = Array.from(new Set(markdown.match(IMAGE_URL_RE) || []));

  // The free-text description paragraph sits between the metadata block and
  // the next "**Variants:**" / "**Image**:" / link section — grab it by
  // position rather than a named field, since the markdown has no explicit
  // "Description:" label.
  const descMatch = markdown.match(/\n\n([^\n#*].+?)(?=\n\n\*\*|\n\n\[View|$)/s);

  return {
    name: titleMatch[1].trim(),
    category: categoryMatch ? categoryMatch[1].trim() : "",
    price_lkr: priceMatch ? priceMatch[1].replace(/,/g, "") : "",
    full_description: descMatch ? descMatch[1].trim() : "",
    product_page_url: urlMatch ? urlMatch[1] : "",
    images,
  };
}

/** Same product-ID-or-keyword-search fallback as resolveKaprukaProduct, but
 * returns the fuller detail set for auto-filling Ad_Product_Mapping. */
async function resolveKaprukaProductDetails(productCode) {
  const text = await kaprukaMcp.callTool("kapruka_get_product", { product_id: productCode });
  const parsed = parseKaprukaProductDetails(text);
  if (parsed) return parsed;

  const productId = await findProductIdByName(productCode);
  if (!productId) return null;

  const retryText = await kaprukaMcp.callTool("kapruka_get_product", { product_id: productId });
  return parseKaprukaProductDetails(retryText);
}

function extFromContentType(contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

async function downloadAndUpload({ url, parentId, filenamePrefix, index }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (${res.status})`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = extFromContentType(contentType);

  return googleDrive.uploadImage({
    parentId,
    filename: `${filenamePrefix}_${index}.${ext}`,
    mimeType: contentType,
    buffer,
  });
}

/**
 * Runs the full pipeline for one product code. Returns a summary object;
 * never throws for partial failures (e.g. Daraz has no confident match) —
 * those show up as `warnings` so the dashboard can display them.
 */
async function fetchImagesForProduct(productCode) {
  const warnings = [];

  const product = await resolveKaprukaProduct(productCode);
  if (!product) {
    throw new Error(`Kapruka product not found for code: ${productCode}`);
  }

  const { pendingFolderId, officialFolderId } = await googleDrive.getProductFolders(productCode);

  // 1. Official Kapruka image(s) — trusted source, auto-approved.
  const officialReviewIds = [];
  for (let i = 0; i < product.images.length; i++) {
    try {
      const uploaded = await downloadAndUpload({
        url: product.images[i],
        parentId: officialFolderId,
        filenamePrefix: "official",
        index: i + 1,
      });
      const reviewId = await googleSheets.addImageReviewRow({
        productCode,
        productName: product.name,
        source: "Kapruka",
        imageUrl: uploaded.viewUrl,
        driveFileId: uploaded.fileId,
      });
      await googleSheets.updateImageReviewStatus(reviewId, "Approved");
      officialReviewIds.push(reviewId);
    } catch (err) {
      warnings.push(`Failed to upload official image ${i + 1}: ${err.message}`);
    }
  }

  // 2. Daraz customer-review photos — staged for manual approval.
  const darazReviewIds = [];
  let darazMatch = null;
  try {
    const candidates = await darazScraper.searchProducts(product.name, { limit: 5 });
    darazMatch = darazScraper.pickBestMatch(product.name, candidates);

    if (!darazMatch) {
      warnings.push("No confident Daraz match found for this product — skipped review-photo scraping.");
    } else {
      const imageUrls = await darazScraper.getReviewImages(darazMatch.url, { maxImages: 8 });
      if (imageUrls.length === 0) {
        warnings.push("Matched a Daraz listing but found no review photos on it.");
      }
      for (let i = 0; i < imageUrls.length; i++) {
        try {
          const { buffer, contentType } = await darazScraper.downloadImage(imageUrls[i]);
          const uploaded = await googleDrive.uploadImage({
            parentId: pendingFolderId,
            filename: `daraz_review_${i + 1}.${extFromContentType(contentType)}`,
            mimeType: contentType,
            buffer,
          });
          const reviewId = await googleSheets.addImageReviewRow({
            productCode,
            productName: product.name,
            source: "Daraz",
            imageUrl: uploaded.viewUrl,
            driveFileId: uploaded.fileId,
          });
          darazReviewIds.push(reviewId);
        } catch (err) {
          warnings.push(`Failed to upload Daraz image ${i + 1}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    warnings.push(`Daraz scraping failed: ${err.message}`);
  }

  return {
    productCode,
    productName: product.name,
    officialImagesUploaded: officialReviewIds.length,
    darazMatch: darazMatch ? { title: darazMatch.title, url: darazMatch.url, matchScore: darazMatch.matchScore } : null,
    darazImagesPending: darazReviewIds.length,
    warnings,
  };
}

module.exports = {
  fetchImagesForProduct,
  resolveKaprukaProduct,
  parseKaprukaProduct,
  resolveKaprukaProductDetails,
  parseKaprukaProductDetails,
};
