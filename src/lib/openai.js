"use strict";

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const kaprukaTools = require("./kaprukaTools");
const googleSheets = require("./googleSheets");
const productImagePipeline = require("./productImagePipeline");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// GPT-5.x/o-series models default to reasoning mode and reject unrelated
// params they don't know about (e.g. gpt-4o 400s on an unrecognized
// reasoning_effort) — only send it to models that actually support it.
const MODEL_SUPPORTS_REASONING_EFFORT = /^(gpt-5|o[1-9])/.test(MODEL);
const REASONING_EFFORT_PARAM = MODEL_SUPPORTS_REASONING_EFFORT ? { reasoning_effort: "none" } : {};

// The bot's persona/rules are editable live from the dashboard's Agent Role
// tab, saved to the Agent_Config sheet — this and the bot are separate
// deployments with separate filesystems, so Sheets (not a local file) is the
// shared source of truth. prompts/agent.md is only the starting default,
// used until someone saves an edit, and as a fallback if Sheets is briefly
// unreachable.
const AGENT_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "agent.md");
const DEFAULT_SYSTEM_PROMPT = fs.readFileSync(AGENT_PROMPT_PATH, "utf8");

let promptCache = DEFAULT_SYSTEM_PROMPT;
let promptCacheLoadedAt = 0;
const PROMPT_CACHE_TTL_MS = 60 * 1000;

async function getSystemPrompt() {
  const now = Date.now();
  if (now - promptCacheLoadedAt < PROMPT_CACHE_TTL_MS) return promptCache;

  try {
    const saved = await googleSheets.getAgentPrompt();
    promptCache = saved || DEFAULT_SYSTEM_PROMPT;
  } catch (err) {
    console.error("[openai] Failed to load agent prompt from Sheets, using local default:", err);
    // Keep serving whatever was cached last rather than falling back to the
    // bundled default on a transient Sheets error mid-conversation.
  }
  promptCacheLoadedAt = now;
  return promptCache;
}

const CLOSING_QUESTIONS = {
  "Sinhala script": "ඔබට මෙය ඕඩර් කරන්න කැමතිද?",
  "Singlish (romanized Sinhala, mixed with English)": "Order karana kamathi dha?",
  English: "Would you like to place the order?",
};

/** Picks the closing-offer follow-up question in the customer's language,
 * based on the same deterministic detector used for the main reply — kept
 * as a fixed template (not model-generated) so the exact wording the
 * business wants is guaranteed, and generated separately from the main
 * reply so it can be sent as its own delayed message. */
function getClosingQuestion(history) {
  const style = detectLanguageStyle(history);
  return CLOSING_QUESTIONS[style] || CLOSING_QUESTIONS.English;
}

/** Strips all structured markers ([[ESCALATE]], [[OFFER_CLOSE]],
 * [[ORDER_INFO: ...]]) from a raw model reply and reports what was found,
 * so the caller can act on each signal without any of them ever reaching
 * the customer. */
function extractMarkers(rawText) {
  let text = rawText;
  let escalated = false;
  let offerClose = false;
  let orderInfo = null;

  if (text.includes("[[ESCALATE]]")) {
    escalated = true;
    text = text.split("[[ESCALATE]]").join("");
  }

  if (text.includes("[[OFFER_CLOSE]]")) {
    offerClose = true;
    text = text.split("[[OFFER_CLOSE]]").join("");
  }

  const orderMatch = text.match(
    /\[\[ORDER_INFO:\s*name="([^"]*)"\s*\|\s*phone="([^"]*)"\s*\|\s*address="([^"]*)"\s*\]\]/i
  );
  if (orderMatch) {
    orderInfo = { name: orderMatch[1], phone: orderMatch[2], address: orderMatch[3] };
    text = text.replace(orderMatch[0], "");
  }

  return { text: text.trim(), escalated, offerClose, orderInfo };
}

function buildProductContextBlock(productContext) {
  if (!productContext) return null;

  const { product_name, category, price_lkr, full_description } = productContext;

  // Deliberately excludes product_page_url and drive_images_folder_link —
  // the bot never sends links/URLs to customers (see system prompt); photos
  // go out as real attachments via the send_product_photos tool instead.
  return [
    "This conversation started from an ad for the following product — use these exact details when answering:",
    `- Product: ${product_name || "N/A"}`,
    `- Category: ${category || "N/A"}`,
    `- Price: ${price_lkr ? `LKR ${price_lkr}` : "N/A"}`,
    `- Description: ${full_description || "N/A"}`,
    "- Delivery: flat LKR 400 nationwide for this order — use this if the customer asks about delivery cost.",
  ].join("\n");
}

const SEND_PHOTOS_TOOL = {
  type: "function",
  function: {
    name: "send_product_photos",
    description:
      "Sends the customer 1-3 real photos of ONE product directly in the chat as actual image attachments. ALWAYS use this instead of describing a photo in words or mentioning any link/URL. If this conversation started from an ad, call it with no arguments to send that product's photos. For any other product — one found via kapruka_search_products or kapruka_get_product — pass its product_id so the right photos get sent. If the customer wants photos of SEVERAL products (e.g. \"send photos of all of these\", after you listed multiple items), call this tool once PER product, one call per product_id, in the same turn — don't just send photos for one of them.",
    parameters: {
      type: "object",
      properties: {
        product_id: {
          type: "string",
          description:
            "The Kapruka product ID from a prior search/get_product result. Omit only if sending photos for the ad's pre-loaded product.",
        },
      },
    },
  },
};

/** Handler for the send_product_photos tool. sendPhotos is provided by the
 * caller (server.js) and actually delivers the Messenger attachments; when
 * omitted (e.g. the dashboard's Test Bot playground) the lookup still runs
 * but nothing is actually sent, so the tool is safe to exercise there.
 *
 * Two sources, tried in order:
 * 1. The ad's pre-loaded product_code, if this is an ad conversation and no
 *    other product_id was given — uses Approved Image_Review rows (curated,
 *    can include real customer review photos from the Daraz pipeline).
 * 2. Any product_id the model supplies (organic/searched products, or an ad
 *    product with nothing Approved yet) — fetched live from Kapruka's own
 *    catalog photo(s), which don't need manual review since they're the
 *    store's own official images, not third-party content. */
async function runSendPhotosTool({ productContext, sendPhotos, args }) {
  const explicitProductId = args && args.product_id;
  const adProductCode = productContext && productContext.product_code;

  let images = [];
  let productMeta = null;

  if (!explicitProductId && adProductCode) {
    images = await googleSheets.getApprovedImages(adProductCode, 3);
    if (images.length > 0) {
      productMeta = {
        product_id: adProductCode,
        product_name: productContext.product_name,
        price_lkr: productContext.price_lkr,
      };
    }
  }

  if (images.length === 0) {
    const productId = explicitProductId || adProductCode;
    if (!productId) {
      return "No product specified — cannot look up photos. Search for the product first, or ask which product they mean.";
    }
    try {
      const details = await productImagePipeline.resolveKaprukaProductDetails(productId);
      images = ((details && details.images) || []).slice(0, 3).map((url) => ({ url }));
      if (images.length > 0 && details) {
        productMeta = { product_id: productId, product_name: details.name, price_lkr: details.price_lkr };
      }
    } catch (err) {
      return `Could not fetch photos for that product: ${err.message}`;
    }
  }

  if (images.length === 0) {
    return "No photos available for this product right now.";
  }
  if (!sendPhotos) {
    return `(Test mode) Would send ${images.length} photo(s) here.`;
  }
  await sendPhotos(images, productMeta);
  return `Sent ${images.length} photo(s) to the customer.`;
}

// Short STEMS (not whole words) matched as plain substrings, specifically
// because Singlish spelling varies a lot between customers (thiyanawada vs
// thiyanawadha vs thiyenawa...) — matching a distinctive prefix is far more
// forgiving than requiring an exact word match.
const SINGLISH_STEMS = [
  "thiyan", "thiyen", // thiyanawa(da/dha), thiyenawa(da/dha)
  "kiyad", "kiyann", // kiyada/kiyanawa/kiyanna
  "monawa", "mokada", // monawada, mokada
  "puluwan", // puluwanda/puluwan
  "kohomad", "kohed", // kohomada, kohedha
  "kochchar", // kochchara ("how much")
  "sthuthi", "sthooti",
  "ayubowan",
  "godak",
  "oyata", "oyala", "oyage",
  " mata ", // mata ("to me") — bare form beyond the "mata one/ona" combos below; boundaried to avoid "automata"
  "mata one", "mata ona",
  "ewana", "ewanna", // ewana/ewanna ("send")
  "gana kiyad", "gaana kiyad",
  "danna", "ganna",
  "meka ", "eeka ",
  "nathuwa",
  "welata", "wenna", // welata (for/to), wenna (for)
  "kokad", // kokada/kokadha ("which one")
  "ondao", "onada", // ona da/ondao ("is ... needed/good") — kept as single tokens; "one da"/"ona da" with a space would false-positive on English phrases like "someone dared"
  " mage ", // mage ("my") — needs both boundaries: bare "mage " would false-positive on "image"/"damage"/"manage"
];

function containsSinhalaScript(text) {
  return /[඀-෿]/.test(text);
}

/** Returns a CONFIDENT style for this one message, or null if there's no
 * clear signal either way (e.g. Sinhala script, or a known Singlish stem).
 * Substring matching on short stems, not exact words, so it tolerates the
 * spelling variation Singlish actually has — but this list can never be
 * complete (Sinhala romanization has no fixed spelling), which is exactly
 * why callers must NOT treat "no stem matched" as "confidently English". */
function detectConfidentStyle(text) {
  if (!text) return null;
  if (containsSinhalaScript(text)) return "Sinhala script";
  const lower = ` ${text.toLowerCase()} `;
  const hasSinglishMarker = SINGLISH_STEMS.some((stem) => lower.includes(stem));
  return hasSinglishMarker ? "Singlish (romanized Sinhala, mixed with English)" : null;
}

/** Global rule for language matching, not a per-word whitelist: a short
 * message (≤4 words — "boyfriend?", "yes", "yes please") carries too little
 * signal to judge on its own, so on ambiguity it inherits whatever style was
 * last confidently established earlier in the conversation, rather than
 * hard-resetting to English just because this one fragment happened to
 * contain no recognized Singlish stem. A longer message with no signal is
 * trusted as genuinely English (enough words to have shown Singlish if it
 * were Singlish) — this is what stops the inheritance from ever getting
 * "stuck" once the customer actually switches to plain English.
 *
 * This directly fixes the class of bug where the stem list is missing a
 * word: a customer who was already in a Singlish conversation and sends a
 * short ambiguous follow-up no longer gets bounced to English just because
 * that one fragment doesn't happen to contain a listed stem. */
function detectLanguageStyle(history) {
  const userMessages = [...history].reverse().filter((m) => m.role === "user");
  const [latest, ...earlier] = userMessages;
  const latestText = typeof latest?.content === "string" ? latest.content : "";

  const confident = detectConfidentStyle(latestText);
  if (confident) return confident;

  const isShortAndAmbiguous = latestText.trim().split(/\s+/).filter(Boolean).length <= 4;
  if (isShortAndAmbiguous) {
    for (const m of earlier) {
      const priorStyle = detectConfidentStyle(typeof m.content === "string" ? m.content : "");
      if (priorStyle) return priorStyle;
    }
  }

  return "English";
}

function buildLanguageReminder(history) {
  const style = detectLanguageStyle(history);
  return {
    role: "system",
    content: `Reminder: the customer's most recent message is in ${style}. Your reply MUST be in ${style} to match them — regardless of what language any product data or tool results are in.`,
  };
}

const ORGANIC_CONTEXT_BLOCK =
  "This conversation didn't start from a specific ad, so no product is pre-loaded. Use your tools to search the catalog, check delivery, or track an order whenever the customer asks about one.";

const AD_CONTEXT_TOOLS_NOTE =
  "You already have full details for this ad's product above — don't call kapruka_search_products or kapruka_get_product for it again, and use the flat LKR 400 delivery rate above instead of kapruka_check_delivery for THIS order. Only reach for your tools if the customer asks about a different product, wants to browse other categories, or wants to track an existing order.";

const TOOLS_AVAILABLE_BLOCK = `You have live tools connected to the store's real catalog and order system — use them instead of guessing:
- kapruka_search_products / kapruka_get_product — to answer any product or catalog question
- kapruka_list_categories — if the customer wants to browse or asks what you sell
- kapruka_list_delivery_cities / kapruka_check_delivery — for delivery questions
- kapruka_track_order — for order status questions (you'll need the customer's order number)

Always call the relevant tool rather than answering from memory. If a tool returns no results or an error, say so honestly and offer to connect them with the team.

Tool results sometimes contain raw links (e.g. "[View on Kapruka](...)") — never copy those into your reply. Describe the product/info in your own words instead; the customer never needs to leave this chat.

If the customer wants to see a photo of a product, use send_product_photos with that product's ID (from the "ID:" field in a search/get_product result) — never paste an image URL into your reply, even in markdown image syntax. You will NOT already have the ID if the product was only named in an earlier message (tool results don't carry over between turns) — in that case call kapruka_search_products for it by name FIRST to get a fresh ID, then call send_product_photos with that ID, both in the same turn. Don't tell the customer no photo is available just because you don't have the ID yet — go get it.

If the customer wants photos of MULTIPLE products (e.g. you just listed several items and they say "send me all the photos" or "photos of these please"), call send_product_photos once per product — one call per product_id — so every one of them actually gets a real photo, not just the first. Example: you listed 3 racks, customer says "yes show me all of them" → call send_product_photos 3 times, once with each rack's product_id, then a single reply like "Here are photos of all three!" covering all of them — don't silently send only one and call it done.`;

/**
 * Reply for any conversation — ad-triggered (product context pre-loaded) or
 * organic (nothing known yet). Tools are always available so the bot can
 * still help if a conversation drifts off the ad's product; the model just
 * won't need them in the common case where the given context already answers
 * the question, since tool_choice is "auto".
 */
async function generateReply({ history, productContext, sendPhotos, pinnedProduct }) {
  const basePrompt = await getSystemPrompt();
  const contextBlock = productContext
    ? `${buildProductContextBlock(productContext)}\n\n${AD_CONTEXT_TOOLS_NOTE}`
    : ORGANIC_CONTEXT_BLOCK;
  const systemPrompt = `${basePrompt}\n\n${contextBlock}\n\n${TOOLS_AVAILABLE_BLOCK}`;
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const languageReminder = buildLanguageReminder(history);

  // Set when the customer's incoming message is a Messenger "swipe reply"
  // directly on a photo the bot sent earlier — lets the model answer
  // "how much is this" etc. about that exact product without re-asking.
  const pinnedProductReminder = pinnedProduct
    ? {
        role: "system",
        content: `The customer's most recent message is a direct reply to a photo you sent earlier, of this exact product — answer about THIS product specifically, don't ask which product they mean:\n- Product: ${pinnedProduct.product_name}\n- Price: LKR ${pinnedProduct.price_lkr}`,
      }
    : null;

  const tools = [...kaprukaTools.TOOL_DEFINITIONS, SEND_PHOTOS_TOOL];

  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      // Reminders are appended fresh each call (not pushed into `messages`)
      // so they stay the most recent thing the model reads, however much
      // tool-call/result content piles up in between.
      messages: [...messages, pinnedProductReminder, languageReminder].filter(Boolean),
      tools,
      tool_choice: "auto",
      temperature: 0.3,
      max_completion_tokens: 800,
      // GPT-5.x models default to reasoning mode, which the Chat Completions
      // endpoint refuses to combine with function tools — this bot's tool
      // calling is core to how it works, so reasoning is turned off rather
      // than migrating to the /v1/responses endpoint.
      ...REASONING_EFFORT_PARAM,
    });

    const message = completion.choices[0]?.message;
    if (!message) return { text: "", escalated: false };

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return extractMarkers((message.content || "").trim());
    }

    // Model wants to call one or more tools — execute them and feed results back.
    messages.push(message);

    for (const toolCall of message.tool_calls) {
      let resultText;
      try {
        const args = JSON.parse(toolCall.function.arguments || "{}");
        if (toolCall.function.name === "send_product_photos") {
          resultText = await runSendPhotosTool({ productContext, sendPhotos, args });
        } else {
          resultText = await kaprukaTools.executeTool(toolCall.function.name, args);
        }
      } catch (err) {
        resultText = `Error calling ${toolCall.function.name}: ${err.message}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultText,
      });
    }
  }

  // Hit the iteration cap — ask once more, without tools, for a final answer.
  const fallback = await client.chat.completions.create({
    model: MODEL,
    messages: [
      ...messages,
      pinnedProductReminder,
      languageReminder,
      {
        role: "system",
        content: "Give your best final answer to the customer now, without calling any more tools.",
      },
    ].filter(Boolean),
    temperature: 0.3,
    max_completion_tokens: 400,
    ...REASONING_EFFORT_PARAM,
  });
  return extractMarkers(fallback.choices[0]?.message?.content?.trim() || "");
}

module.exports = { generateReply, getClosingQuestion };
