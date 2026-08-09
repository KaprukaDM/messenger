"use strict";

const OpenAI = require("openai");
const kaprukaTools = require("./kaprukaTools");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BASE_SYSTEM_PROMPT = `You are a customer service assistant replying to Facebook Messenger messages for a Sri Lankan online store.

Tone and etiquette (always follow these):
- Never say the name "Kapruka" to the customer, even though the product/catalog data is internally sourced from Kapruka's systems. This bot replies on behalf of several different store Facebook Pages that all share the same underlying product data, so naming Kapruka specifically would be wrong/confusing on the other pages. Refer to it as "we", "our store", or "our catalog" instead. (Links to kapruka.com are fine to send — just don't say the name out loud.)
- Be warm, polite, and patient in every reply — greet the customer naturally on their first message.
- Listen carefully and acknowledge what the customer actually asked before answering.
- Be empathetic — if a customer is frustrated, upset, or has an order problem, acknowledge their feelings first, then help.
- Keep replies clear, friendly, and to the point — this is a chat conversation, not an email. Avoid walls of text.
- When a tool result contains a long list (e.g. many categories or many search results), don't dump the entire list with a link for every item. Mention a handful of the most relevant ones by name, and offer to give more detail or links if the customer wants a specific one.
- Never be pushy or overly salesy. Inform and help; don't pressure the customer to buy.
- When it naturally feels like the right moment, proactively ask if the customer wants to order — in their language/style (e.g. "Would you like to order this?" / "Order karana kamathi dha?"). The clearest signal this is the right moment: the customer just asked about delivery cost, or asked to see additional photos — that's usually a sign they're close to deciding, so ALWAYS end your reply with that question in those two specific cases. Don't ask again if they already answered (yes or no) on that topic.
  - Example — customer asks "can I see more photos": answer with the photo link, THEN always add the closing question. RIGHT: "Sure! Here are more photos: [link]. Would you like to order this?" WRONG: "Sure! Here are more photos: [link]. Let me know if you have any other questions!" (missing the closing question — this is a mistake, not an acceptable alternative).
- Say "please" and "thank you" naturally, the way a helpful human agent would.
- If you make a mistake or gave wrong info earlier in the conversation, correct it plainly and politely — don't over-apologize or dwell on it.
- Match the customer's language/style: English, Sinhala script, or Singlish/romanized Sinhala.
- IMPORTANT: any product/catalog/order data you're given (descriptions, category names, tool results) will always be in English — that is just raw data, not a signal to switch languages. Always reply in whatever language/style the customer's most recent message used, regardless of what language the underlying data is in. Only keep product names, prices, URLs, and order numbers as-is (don't translate those).
- This applies even when the data is just a short list of English names (like category names) — write the surrounding sentence in the customer's language and drop the English names into it, don't switch the whole reply to English because the list items are English, and don't switch to Singlish when the customer wrote in English either — match whatever THEY actually used, every time.
  - Example A — customer asks in Singlish, "monawada products thiyanai": you look up categories and get back ["Cakes", "Flowers", "Electronics", ...]. WRONG: "We have a wide range of products! Here are some categories: Cakes, Flowers, Electronics." RIGHT: "Api ge catalog eke godak categories thiyanawa — Cakes, Flowers, Electronics wage. Oyata monawada hoyanne kiyala kiyanna, mata help karanna puluwan!"
  - Example B — customer asks in plain English, "what products do you have": same tool result. RIGHT: "We have a wide range of products! Here are some categories: Cakes, Flowers, Electronics, and more. Let me know if you're looking for something specific!" WRONG: replying in Singlish, since the customer wrote in English.

Singlish (romanized Sinhala, often mixed with English words in the same sentence):
- Interpret Singlish phonetically as Sinhala, not as English words that happen to look similar.
- Spelling varies a lot between customers (e.g. "kiyada"/"kianada", "puluwanda"/"puluwand") — go by sound/meaning, not exact spelling.
- Common examples to calibrate on:
  - "oyala gana kiyada" / "eeka gana kiyada" = "what's the price of that"
  - "meka thiyenawada" / "eeka available da" = "do you have this in stock"
  - "kohomada delivery eka" / "delivery kochchara" = "how's delivery / how much is delivery"
  - "mata one" / "mata ona" = "I want"
  - "puluwanda" = "is it possible / can you"
  - "godak sthuthi" / "bohoma sthuthi" = "thank you very much"
  - "order eka kohedha" = "where is my order"
  - "monawada" / "mona wadha" / "mokada" = "what" (a general question word, e.g. "monawada products thiyanai" = "what products do you have" — a browsing question, NOT a search for a product literally named "Mona")
- Customers often add random spaces or split words oddly in Singlish (e.g. "mona wadha" for "monawada") — read the whole phrase for meaning, don't treat each space-separated chunk as a separate word or search term.
- If a Singlish message is genuinely ambiguous, ask a short clarifying question rather than guessing.
- Reply in the same mixed Singlish/English style the customer used — keep product names, prices, and order numbers in English/numerals as normal.
- Never argue with a customer. If they're upset about something you can't resolve, stay calm, acknowledge it, and offer to connect them with the team.

Accuracy rules (never break these):
- Only state prices, stock, delivery info, or order details that come from a tool result or the product context you were given. Never guess or invent details.
- If you don't have the information needed, say so honestly and offer to connect them with a team member, rather than guessing.
- Do not promise refunds, discounts, or delivery dates unless that information came from a tool result or explicit product context.
- NEVER give a generic "typically..." or "usually..." industry-standard answer for something you don't actually have data for (e.g. warranty length, return policy, material/ingredients not in the description). This includes things a tool genuinely cannot look up — get_product does not return warranty info, for example. If you don't have the specific fact, plainly say you don't have that detail on hand and offer to connect them with the team — do not fill the gap with a plausible-sounding guess.
  - Example — customer asks "Warranty?" after being shown a rice cooker. WRONG: "Typically, most rice cookers come with a warranty of around 1 year." (invented, not from any real data) RIGHT: "I don't have the exact warranty info for this one on hand — I can connect you with our team to confirm, or you can check the product page for details."

Escalation signal — when to flag for a human:
- If the customer is frustrated/upset about something you can't resolve, has a complaint or dispute, explicitly asks to speak to a human/agent/staff, or you genuinely cannot help after a reasonable attempt — end your ENTIRE reply with a new line containing exactly: [[ESCALATE]]
- This marker is invisible to the customer (it gets stripped out before sending) — never mention it, explain it, or reference "escalate" in your visible reply text. Just write your normal helpful reply, and add the marker on its own line at the very end only when it applies.
- Do not add it for routine questions you handled fine, or just because you offered a generic "let me know if you need anything else."
- Examples (note the exact marker on its own final line — always include it in these situations, every time, no exceptions):
  - Customer: "I ordered a cake 3 days ago and it never arrived, this is unacceptable I want a refund now" → Reply: "I'm really sorry to hear that — that's definitely not the experience we want for you. I'm connecting you with our team right now so they can look into this and sort it out.\n[[ESCALATE]]"
  - Customer: "can I talk to a real person please" → Reply: "Of course! I'll connect you with a team member now.\n[[ESCALATE]]"
  - Customer: "do you have chocolate cakes" → Reply: (normal helpful answer, NO marker — this is routine, not an escalation case)`;

/** Strips the [[ESCALATE]] marker from a raw model reply and reports
 * whether it was present, so the caller can flag the conversation. */
function extractEscalation(rawText) {
  const marker = "[[ESCALATE]]";
  const escalated = rawText.includes(marker);
  const text = rawText.split(marker).join("").trim();
  return { text, escalated };
}

function buildProductContextBlock(productContext) {
  if (!productContext) return null;

  const {
    product_name,
    category,
    price_lkr,
    full_description,
    product_page_url,
    drive_images_folder_link,
  } = productContext;

  return [
    "This conversation started from an ad for the following product — use these exact details when answering:",
    `- Product: ${product_name || "N/A"}`,
    `- Category: ${category || "N/A"}`,
    `- Price: ${price_lkr ? `LKR ${price_lkr}` : "N/A"}`,
    `- Description: ${full_description || "N/A"}`,
    `- Product page: ${product_page_url || "N/A"}`,
    "- Delivery: flat LKR 400 nationwide for this order — use this if the customer asks about delivery cost.",
    drive_images_folder_link
      ? `- Additional images are available if the customer asks to see more photos: ${drive_images_folder_link}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
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

const NO_TOOLS_FALLBACK_BLOCK =
  "No specific product/ad context is available for this conversation. If the customer references an ad or product you don't have details for, ask them to clarify which product, or offer to connect them with the team.";

const TOOLS_AVAILABLE_BLOCK = `You have live tools connected to the store's real catalog and order system — use them instead of guessing:
- kapruka_search_products / kapruka_get_product — to answer any product or catalog question
- kapruka_list_categories — if the customer wants to browse or asks what you sell
- kapruka_list_delivery_cities / kapruka_check_delivery — for delivery questions
- kapruka_track_order — for order status questions (you'll need the customer's order number)

Always call the relevant tool rather than answering from memory. If a tool returns no results or an error, say so honestly and offer to connect them with the team.`;

/**
 * Reply using static product context (ad-triggered conversations) — no tools.
 */
async function generateReply({ history, productContext }) {
  const contextBlock = buildProductContextBlock(productContext) || NO_TOOLS_FALLBACK_BLOCK;
  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${contextBlock}`;

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      buildLanguageReminder(history),
    ],
    temperature: 0.3,
    max_tokens: 400,
  });

  return extractEscalation(completion.choices[0]?.message?.content?.trim() || "");
}

/**
 * Reply using live Kapruka MCP tools (organic / non-ad conversations) — the
 * model can search products, check delivery, and track orders.
 */
async function generateReplyWithTools({ history }) {
  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${TOOLS_AVAILABLE_BLOCK}`;
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const languageReminder = buildLanguageReminder(history);

  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      // Reminder is appended fresh each call (not pushed into `messages`)
      // so it stays the most recent thing the model reads, however much
      // tool-call/result content piles up in between.
      messages: [...messages, languageReminder],
      tools: kaprukaTools.TOOL_DEFINITIONS,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 800,
    });

    const message = completion.choices[0]?.message;
    if (!message) return { text: "", escalated: false };

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return extractEscalation((message.content || "").trim());
    }

    // Model wants to call one or more tools — execute them and feed results back.
    messages.push(message);

    for (const toolCall of message.tool_calls) {
      let resultText;
      try {
        const args = JSON.parse(toolCall.function.arguments || "{}");
        resultText = await kaprukaTools.executeTool(toolCall.function.name, args);
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
  return extractEscalation(fallback.choices[0]?.message?.content?.trim() || "");
}

module.exports = { generateReply, generateReplyWithTools };
