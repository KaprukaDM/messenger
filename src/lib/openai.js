"use strict";

const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BASE_SYSTEM_PROMPT = `You are a friendly, efficient customer service assistant replying to Facebook Messenger messages for a Sri Lankan e-commerce business.

Language:
- Detect the language/style the customer is using (English, Sinhala script, or Singlish/romanized Sinhala) and reply in the same style.
- Keep replies natural and conversational, not robotic.

Behavior rules:
- Only state prices, stock status, or product details that are explicitly given to you in the product context below. Never guess or make up product details, prices, or delivery dates.
- If you don't have the information needed to answer, say so honestly and offer to connect them with a team member, rather than guessing.
- Keep replies short and to the point — this is a chat conversation, not an email.
- Do not promise refunds, discounts, or delivery dates unless that information was explicitly given to you.
- If the customer seems frustrated, upset, or is asking about an order problem/complaint, acknowledge it and offer to escalate to a human — do not try to resolve disputes yourself.`;

function buildProductContextBlock(productContext) {
  if (!productContext) {
    return "No specific product/ad context is available for this conversation. If the customer references an ad or product you don't have details for, ask them to clarify which product, or offer to connect them with the team.";
  }

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

/**
 * Generate a reply.
 * @param {Object} params
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.history
 * @param {Object|null} params.productContext - a row from Ad_Product_Mapping, or null
 * @returns {Promise<string>} reply text
 */
async function generateReply({ history, productContext }) {
  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${buildProductContextBlock(productContext)}`;

  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.6,
    max_tokens: 400,
  });

  return completion.choices[0]?.message?.content?.trim() || "";
}

module.exports = { generateReply };
