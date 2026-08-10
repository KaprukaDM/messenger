"use strict";

/**
 * Best-effort Daraz.lk scraper: search by product name, pick the closest
 * title match, then pull real customer-review photos off the product page.
 * Daraz's DOM structure isn't publicly documented and can change without
 * notice, so the selectors below use broad fallbacks rather than one exact
 * path — expect to re-check these against the live site if Daraz redesigns
 * their search/review layout.
 */

const puppeteer = require("puppeteer");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-overlap similarity, 0..1 — good enough to reject obviously wrong matches. */
function titleSimilarity(a, b) {
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap += 1;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/** Searches Daraz for a product name, returns candidate {title, url, price}. */
async function searchProducts(query, { limit = 5 } = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.daraz.lk/catalog/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });

    await page
      .waitForSelector('[data-qa-locator="product-item"], .Bm3ON', { timeout: 15000 })
      .catch(() => {});

    const candidates = await page.evaluate((max) => {
      const cards = document.querySelectorAll(
        '[data-qa-locator="product-item"], .Bm3ON'
      );
      const results = [];
      for (const card of cards) {
        if (results.length >= max) break;
        const link = card.querySelector("a[href]");
        const titleEl = card.querySelector('[title], .RfADt a, .title');
        const priceEl = card.querySelector(".ooOxS, .price");
        if (!link) continue;
        let href = link.getAttribute("href") || "";
        if (href.startsWith("//")) href = "https:" + href;
        results.push({
          title: (titleEl && (titleEl.getAttribute("title") || titleEl.textContent)) || "",
          url: href,
          price: (priceEl && priceEl.textContent.trim()) || "",
        });
      }
      return results;
    }, limit);

    await page.close();
    return candidates.filter((c) => c.url && c.title);
  });
}

/**
 * Picks the best title match above a minimum similarity threshold, or null
 * if nothing looks close enough to be confident it's the same product.
 */
function pickBestMatch(query, candidates, { minSimilarity = 0.3 } = {}) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = titleSimilarity(query, c.title);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= minSimilarity ? { ...best, matchScore: bestScore } : null;
}

/**
 * Pulls candidate customer-review photo URLs off a Daraz product page.
 * Verified against the live site: Daraz renders real review photos as
 * `.review-image__item .image` divs with a CSS background-image (not <img>
 * tags), served from the lzd-u.slatic.net user-content CDN — distinct from
 * the main product gallery, which lives under a `gallery-preview-panel`
 * class (note: a broad `[class*="review"]` selector wrongly matches that
 * too, since "preview" contains "review" as a substring — that's the exact
 * bug that caused this to grab a seller's marketing photo before).
 */
async function getReviewImages(productUrl, { maxImages = 8 } = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(productUrl, { waitUntil: "networkidle2", timeout: 45000 });

    // Review photos lazy-load once scrolled into view.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
    await page.waitForSelector(".review-image__item .image", { timeout: 10000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const images = await page.evaluate((max) => {
      const imgDivs = document.querySelectorAll(".review-image__item .image");
      const urls = new Set();
      for (const el of imgDivs) {
        const style = el.getAttribute("style") || "";
        const match = style.match(/url\(["']?(.*?)["']?\)/);
        if (!match) continue;
        const url = match[1].replace(/&quot;/g, "");
        urls.add(url.startsWith("//") ? "https:" + url : url);
        if (urls.size >= max) break;
      }
      return Array.from(urls);
    }, maxImages);

    await page.close();
    return images;
  });
}

async function downloadImage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.daraz.lk/" },
  });
  if (!res.ok) throw new Error(`Failed to download image (${res.status}): ${url}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

module.exports = { searchProducts, pickBestMatch, getReviewImages, downloadImage, titleSimilarity };
