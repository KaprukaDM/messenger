"use strict";

/**
 * Very small in-memory per-customer conversation buffer, used to give the
 * OpenAI call recent turn history. Not persistent — restarting the server
 * clears it. The Google Sheets Conversations tab is the durable log.
 */

const MAX_TURNS = 20; // keep last N messages (user+assistant combined)
const store = new Map(); // customerId -> { history: [...], adId: string|null }

function getSession(customerId) {
  if (!store.has(customerId)) {
    store.set(customerId, { history: [], adId: null });
  }
  return store.get(customerId);
}

function addTurn(customerId, role, content) {
  const session = getSession(customerId);
  session.history.push({ role, content });
  if (session.history.length > MAX_TURNS) {
    session.history = session.history.slice(-MAX_TURNS);
  }
}

function setAdId(customerId, adId) {
  if (!adId) return;
  const session = getSession(customerId);
  session.adId = adId;
}

function getAdId(customerId) {
  return getSession(customerId).adId;
}

function getHistory(customerId) {
  return getSession(customerId).history;
}

/**
 * Populate history for a customer ONLY if it's currently empty — used to
 * restore memory from the Google Sheets log after a server restart, without
 * clobbering an already-live in-memory conversation.
 */
function seedHistoryIfEmpty(customerId, historyFromLog) {
  const session = getSession(customerId);
  if (session.history.length === 0 && historyFromLog && historyFromLog.length > 0) {
    session.history = historyFromLog.slice(-MAX_TURNS);
  }
}

module.exports = { addTurn, setAdId, getAdId, getHistory, seedHistoryIfEmpty };
