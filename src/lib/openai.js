"use strict";

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const kaprukaTools = require("./kaprukaTools");
const googleSheets = require("./googleSheets");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const style = detectLanguageStyle(
    typeof lastUserMsg?.content === "string" ? lastUserMsg.content : ""
  );
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
      "Sends the customer 1-3 real photos of this product (official Kapruka photos and/or real customer review photos) directly in the chat. Use this when the customer asks to see photos, more pictures, or what it actually looks like — instead of describing photos in words.",
    parameters: { type: "object", properties: {} },
  },
};

/** Handler for the send_product_photos tool. sendPhotos is provided by the
 * caller (server.js) and actually delivers the Messenger attachments; when
 * omitted (e.g. the dashboard's Test Bot playground) the lookup still runs
 * but nothing is actually sent, so the tool is safe to exercise there. */
async function runSendPhotosTool({ productContext, sendPhotos }) {
  const productCode = productContext && productContext.product_code;
  if (!productCode) {
    return "No product code available for this conversation — cannot look up photos.";
  }
  const images = await googleSheets.getApprovedImages(productCode, 3);
  if (images.length === 0) {
    return "No approved photos found for this product yet.";
  }
  if (!sendPhotos) {
    return `(Test mode) Would send ${images.length} photo(s) here.`;
  }
  await sendPhotos(images);
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
  "mata one", "mata ona",
  "gana kiyad", "gaana kiyad",
  "danna", "ganna",
  "meka ", "eeka ",
  "nathuwa",
];

function containsSinhalaScript(text) {
  return /[඀-෿]/.test(text);
}

/** Lightweight, deterministic language detector — not perfect, but far more
 * reliable than hoping the model infers style correctly from a prompt that's
 * also full of Singlish examples (which was biasing it toward Singlish even
 * for plain English messages). Substring matching on short stems, not exact
 * words, so it tolerates the spelling variation Singlish actually has. */
function detectLanguageStyle(text) {
  if (!text) return "English";
  if (containsSinhalaScript(text)) return "Sinhala script";
  const lower = ` ${text.toLowerCase()} `;
  const hasSinglishMarker = SINGLISH_STEMS.some((stem) => lower.includes(stem));
  return hasSinglishMarker ? "Singlish (romanized Sinhala, mixed with English)" : "English";
}

function buildLanguageReminder(history) {
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const style = detectLanguageStyle(
    typeof lastUserMsg?.content === "string" ? lastUserMsg.content : ""
  );
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

Tool results sometimes contain raw links (e.g. "[View on Kapruka](...)") — never copy those into your reply. Describe the product/info in your own words instead; the customer never needs to leave this chat.`;

/**
 * Reply for any conversation — ad-triggered (product context pre-loaded) or
 * organic (nothing known yet). Tools are always available so the bot can
 * still help if a conversation drifts off the ad's product; the model just
 * won't need them in the common case where the given context already answers
 * the question, since tool_choice is "auto".
 */
async function generateReply({ history, productContext, sendPhotos }) {
  const basePrompt = await getSystemPrompt();
  const contextBlock = productContext
    ? `${buildProductContextBlock(productContext)}\n\n${AD_CONTEXT_TOOLS_NOTE}`
    : ORGANIC_CONTEXT_BLOCK;
  const systemPrompt = `${basePrompt}\n\n${contextBlock}\n\n${TOOLS_AVAILABLE_BLOCK}`;
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const languageReminder = buildLanguageReminder(history);

  const canSendPhotos = Boolean(productContext && productContext.product_code);
  const tools = canSendPhotos
    ? [...kaprukaTools.TOOL_DEFINITIONS, SEND_PHOTOS_TOOL]
    : kaprukaTools.TOOL_DEFINITIONS;

  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      // Reminder is appended fresh each call (not pushed into `messages`)
      // so it stays the most recent thing the model reads, however much
      // tool-call/result content piles up in between.
      messages: [...messages, languageReminder],
      tools,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 800,
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
        if (toolCall.function.name === "send_product_photos") {
          resultText = await runSendPhotosTool({ productContext, sendPhotos });
        } else {
          const args = JSON.parse(toolCall.function.arguments || "{}");
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
      languageReminder,
      {
        role: "system",
        content: "Give your best final answer to the customer now, without calling any more tools.",
      },
    ],
    temperature: 0.3,
    max_tokens: 400,
  });
  return extractMarkers(fallback.choices[0]?.message?.content?.trim() || "");
}

module.exports = { generateReply, getClosingQuestion };
