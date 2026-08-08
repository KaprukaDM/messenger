"use strict";

const kaprukaMcp = require("./kaprukaMcp");

/**
 * OpenAI function-calling tool definitions for the Kapruka MCP tools we
 * expose to the model. Only read-only / informational tools are included —
 * kapruka_create_order (real checkout) is intentionally left out for now.
 */
const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "kapruka_search_products",
      description:
        "Search the Kapruka product catalog by keyword. Use this whenever a customer asks what products are available, or asks about a type of product (e.g. 'do you have school bags', 'birthday cakes under 3000').",
      parameters: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: "Search query, at least 3 characters (e.g. 'birthday cake', 'school bag').",
          },
          category: {
            type: "string",
            description: "Optional category filter (e.g. 'Birthday', 'Flowers').",
          },
          min_price: { type: "number", description: "Minimum price in LKR (optional)." },
          max_price: { type: "number", description: "Maximum price in LKR (optional)." },
          in_stock_only: {
            type: "boolean",
            description: "If true, only show in-stock items. Default false.",
          },
          sort: {
            type: "string",
            enum: ["relevance", "price_asc", "price_desc", "newest", "bestseller"],
            description: "Sort order. Default 'relevance'.",
          },
          limit: { type: "integer", description: "Number of results, 1-50. Default 10." },
        },
        required: ["q"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kapruka_get_product",
      description:
        "Get full details (price, stock, description, images, URL) for one specific Kapruka product by its product ID. Use after a search to answer follow-up questions about a specific item.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string", description: "The Kapruka product ID." },
        },
        required: ["product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kapruka_list_categories",
      description: "List Kapruka's top-level product categories. Use if a customer asks what kinds of things Kapruka sells, or wants to browse.",
      parameters: {
        type: "object",
        properties: {
          depth: { type: "integer", description: "1 or 2 levels of sub-categories. Default 1." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kapruka_list_delivery_cities",
      description:
        "Search/confirm which Sri Lankan cities Kapruka delivers to. Use before checking delivery if you're not sure of the exact city name Kapruka uses.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Partial city name to search for." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kapruka_check_delivery",
      description:
        "Check whether Kapruka can deliver to a given city on a given date, and the delivery fee. Use when a customer asks about delivery availability, delivery cost, or delivery timing.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "Canonical Kapruka city name." },
          delivery_date: { type: "string", description: "YYYY-MM-DD. Defaults to today if omitted." },
          product_id: {
            type: "string",
            description: "Optional — include if known, enables a freshness warning for cakes/flowers.",
          },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kapruka_track_order",
      description:
        "Look up the status and delivery progress of an existing, already-placed Kapruka order by its order number. Use when a customer asks 'where is my order' or gives an order number.",
      parameters: {
        type: "object",
        properties: {
          order_number: {
            type: "string",
            description: "The order number from the customer's Kapruka confirmation email.",
          },
        },
        required: ["order_number"],
      },
    },
  },
];

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

async function executeTool(name, args) {
  if (!TOOL_NAMES.has(name)) {
    throw new Error(`Unknown/disallowed tool: ${name}`);
  }
  return kaprukaMcp.callTool(name, args);
}

module.exports = { TOOL_DEFINITIONS, executeTool };
