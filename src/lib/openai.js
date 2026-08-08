"use strict";

const OpenAI = require("openai");
const kaprukaTools = require("./kaprukaTools");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BASE_SYSTEM_PROMPT = `You are a customer service assistant replying to Facebook Messenger messages for Kapruka, a Sri Lankan e-commerce business.

Tone and etiquette (always follow these):
- Be warm, polite, and patient in every reply — greet the customer naturally on their first message.
- Listen carefully and acknowledge what the customer actually asked before answering.
- Be empathetic — if a customer is frustrated, upset, or has an order problem, acknowledge their feelings first, then help.
- Keep replies clear, friendly, and to the point — this is a chat conversation, not an email. Avoid walls of text.
- Never be pushy or overly salesy. Inform and help; don't pressure the customer to buy.
- Say "please" and "thank you" naturally, the way a helpful human agent would.
- If you make a mistake or gave wrong info earlier in the conversation, correct it plainly and politely — don't over-apologize or dwell on it.
- Match the customer's language/style: English, Sinhala script, or Singlish/romanized Sinhala.

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
- If a Singlish message is genuinely ambiguous, ask a short clarifying question rather than guessing.
- Reply in the same mixed Singlish/English style the customer used — keep product names, prices, and order numbers in English/numerals as normal.
- Never argue with a customer. If they're upset about something you can't resolve, stay calm, acknowledge it, and offer to connect them with the team.

Accuracy rules (never break these):
- Only state prices, stock, delivery info, or order details that come from a tool result or the product context you were given. Never guess or invent details.
- If you don't have the information needed, say so honestly and offer to connect them with a team member, rather than guessing.
- Do not promise refunds, discounts, or delivery dates unless that information came from a tool result or explicit product context.`;

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
    drive_images_folder_link
      ? `- Additional images are available if the customer asks to see more photos: ${drive_images_folder_link}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const NO_TOOLS_FALLBACK_BLOCK =
  "No specific product/ad context is available for this conversation. If the customer references an ad or product you don't have details for, ask them to clarify which product, or offer to connect them with the team.";

const TOOLS_AVAILABLE_BLOCK = `You have live tools connected to Kapruka's real catalog and order system — use them instead of guessing:
- kapruka_search_products / kapruka_get_product — to answer any product or catalog question
- kapruka_list_categories — if the customer wants to browse or asks what you sell
- kapruka_list_delivery_cities / kapruka_check_delivery — for delivery questions
- kapruka_track_order — for order status questions (you'll need the customer's order number)

Always call the relevant tool rather than answering from memory. If a tool returns no results or an error, say so honestly and offer to connect them with the team.

IMPORTANT — tool results are always in English (product names, descriptions, category names), because that's just the raw catalog data. That does NOT mean you should reply in English. Keep replying in whatever language/style the customer has been using (English, Sinhala script, or Singlish) — translate/explain the tool results in their language. Only keep product names, prices, URLs, and order numbers as-is (don't translate those).`;

/**
 * Reply using static product context (ad-triggered conversations) — no tools.
 */
async function generateReply({ history, productContext }) {
  const contextBlock = buildProductContextBlock(productContext) || NO_TOOLS_FALLBACK_BLOCK;
  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${contextBlock}`;

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...history],
    temperature: 0.6,
    max_tokens: 400,
  });

  return completion.choices[0]?.message?.content?.trim() || "";
}

/**
 * Reply using live Kapruka MCP tools (organic / non-ad conversations) — the
 * model can search products, check delivery, and track orders.
 */
async function generateReplyWithTools({ history }) {
  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${TOOLS_AVAILABLE_BLOCK}`;
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: kaprukaTools.TOOL_DEFINITIONS,
      tool_choice: "auto",
      temperature: 0.6,
      max_tokens: 500,
    });

    const message = completion.choices[0]?.message;
    if (!message) return "";

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return (message.content || "").trim();
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
      {
        role: "system",
        content: "Give your best final answer to the customer now, without calling any more tools.",
      },
    ],
    temperature: 0.6,
    max_tokens: 400,
  });
  return fallback.choices[0]?.message?.content?.trim() || "";
}

module.exports = { generateReply, generateReplyWithTools };
