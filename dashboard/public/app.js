function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
const tabButtons = document.querySelectorAll(".tab-btn");
const views = {
  chats: document.getElementById("view-chats"),
  escalated: document.getElementById("view-escalated"),
  orders: document.getElementById("view-orders"),
  images: document.getElementById("view-images"),
  agent: document.getElementById("view-agent"),
  test: document.getElementById("view-test"),
};

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    Object.entries(views).forEach(([name, el]) => {
      el.hidden = name !== tab;
    });
    if (tab === "images") fetchPendingImages();
    if (tab === "agent") loadAgentPrompt();
    if (tab === "test") loadAdOptions();
    if (tab === "escalated") renderEscalatedList();
    if (tab === "orders") fetchOrders();
  });
});

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------
const customerListEl = document.getElementById("customerList");
const threadHeaderEl = document.getElementById("threadHeader");
const threadMessagesEl = document.getElementById("threadMessages");
const searchEl = document.getElementById("search");
const escalatedOnlyEl = document.getElementById("escalatedOnly");

let customers = [];
let selectedCustomerId = null;

async function fetchCustomers() {
  const res = await fetch("/api/customers");
  customers = await res.json();
  renderCustomerList();
  updateEscalatedBadge();
}

function updateEscalatedBadge() {
  const count = customers.filter((c) => c.status === "Escalated").length;
  const badge = document.getElementById("escalatedCount");
  badge.hidden = count === 0;
  badge.textContent = count;
}

async function fetchMessages(customerId) {
  const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}/messages`);
  return res.json();
}

function renderCustomerList() {
  const search = searchEl.value.trim().toLowerCase();
  const escalatedOnly = escalatedOnlyEl.checked;

  const filtered = customers.filter((c) => {
    if (escalatedOnly && c.status !== "Escalated") return false;
    if (!search) return true;
    const haystack = `${c.name || ""} ${c.customer_id || ""}`.toLowerCase();
    return haystack.includes(search);
  });

  customerListEl.innerHTML = "";

  if (filtered.length === 0) {
    customerListEl.innerHTML = '<div class="empty-state">No conversations found.</div>';
    return;
  }

  for (const c of filtered) {
    const item = document.createElement("div");
    item.className = "customer-item" + (c.customer_id === selectedCustomerId ? " active" : "");
    item.onclick = () => selectCustomer(c.customer_id, c.name);

    const escalatedBadge =
      c.status === "Escalated" ? '<span class="badge escalated">Escalated</span>' : "";

    item.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(c.name || c.customer_id)}</span>
        ${escalatedBadge}
      </div>
      <div class="meta">
        <span class="badge platform">${escapeHtml(c.platform || "")}</span>
        &nbsp;${escapeHtml(c.last_contact_date || "")} · ${escapeHtml(c.total_messages || "0")} msgs
        ${c.last_ad_id ? ` · ad:${escapeHtml(c.last_ad_id)}` : ""}
      </div>
    `;
    customerListEl.appendChild(item);
  }
}

async function selectCustomer(customerId, name) {
  selectedCustomerId = customerId;
  renderCustomerList();
  threadHeaderEl.textContent = name || customerId;
  threadMessagesEl.innerHTML = '<div class="empty-state">Loading…</div>';

  const messages = await fetchMessages(customerId);
  renderThread(messages);
}

function renderThread(messages) {
  threadMessagesEl.innerHTML = "";
  if (messages.length === 0) {
    threadMessagesEl.innerHTML = '<div class="empty-state">No messages yet.</div>';
    return;
  }

  for (const m of messages) {
    const bubble = document.createElement("div");
    const isIncoming = m.direction === "Incoming";
    bubble.className = "bubble " + (isIncoming ? "incoming" : "outgoing");
    bubble.innerHTML = `${escapeHtml(m.message_text || "")}<span class="timestamp">${escapeHtml(
      m.timestamp || ""
    )}${m.escalated === "Yes" ? " · escalated" : ""}</span>`;
    threadMessagesEl.appendChild(bubble);
  }

  threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
}

searchEl.addEventListener("input", renderCustomerList);
escalatedOnlyEl.addEventListener("change", renderCustomerList);

fetchCustomers();
setInterval(fetchCustomers, 15000);
setInterval(() => {
  if (selectedCustomerId) {
    fetchMessages(selectedCustomerId).then(renderThread);
  }
}, 15000);

// ---------------------------------------------------------------------------
// Product Images
// ---------------------------------------------------------------------------
const productCodeInput = document.getElementById("productCodeInput");
const fetchImagesBtn = document.getElementById("fetchImagesBtn");
const fetchStatusEl = document.getElementById("fetchStatus");
const fetchSummaryEl = document.getElementById("fetchSummary");
const pendingGridEl = document.getElementById("pendingGrid");

async function fetchPendingImages() {
  const res = await fetch("/api/image-review?status=Pending");
  const rows = await res.json();
  renderPendingGrid(rows);
}

function renderPendingGrid(rows) {
  pendingGridEl.innerHTML = "";
  if (rows.length === 0) {
    pendingGridEl.innerHTML = '<div class="empty-state">Nothing waiting for review.</div>';
    return;
  }

  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "image-card";
    const directUrl = `https://drive.google.com/uc?export=view&id=${row.drive_file_id}`;
    card.innerHTML = `
      <img src="${directUrl}" alt="" loading="lazy" />
      <div class="meta">${escapeHtml(row.product_name || row.product_code)}<br/>${escapeHtml(row.source)}</div>
      <div class="actions">
        <button class="approve">Approve</button>
        <button class="reject">Reject</button>
      </div>
    `;
    card.querySelector(".approve").onclick = () => decideImage(row.review_id, "approve");
    card.querySelector(".reject").onclick = () => decideImage(row.review_id, "reject");
    pendingGridEl.appendChild(card);
  }
}

async function decideImage(reviewId, decision) {
  await fetch(`/api/image-review/${encodeURIComponent(reviewId)}/${decision}`, { method: "POST" });
  fetchPendingImages();
}

fetchImagesBtn.addEventListener("click", async () => {
  const code = productCodeInput.value.trim();
  if (!code) return;

  fetchImagesBtn.disabled = true;
  fetchStatusEl.textContent = "Fetching from Kapruka + Daraz — this can take up to a minute...";
  fetchSummaryEl.textContent = "";

  try {
    const res = await fetch(`/api/products/${encodeURIComponent(code)}/fetch-images`, { method: "POST" });
    const summary = await res.json();
    if (!res.ok) throw new Error(summary.error || "Failed");

    const lines = [
      `${summary.productName}`,
      `Official images uploaded: ${summary.officialImagesUploaded}`,
      summary.darazMatch
        ? `Daraz match: "${summary.darazMatch.title}" (score ${summary.darazMatch.matchScore.toFixed(2)}) — ${summary.darazImagesPending} photo(s) staged for review`
        : "No confident Daraz match found",
      ...summary.warnings.map((w) => `Warning: ${w}`),
    ];
    fetchSummaryEl.textContent = lines.join("\n");
    fetchPendingImages();
  } catch (err) {
    fetchSummaryEl.textContent = `Error: ${err.message}`;
  } finally {
    fetchStatusEl.textContent = "";
    fetchImagesBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Agent Role
// ---------------------------------------------------------------------------
const agentEditor = document.getElementById("agentPromptEditor");
const agentSaveBtn = document.getElementById("agentSaveBtn");
const agentReloadBtn = document.getElementById("agentReloadBtn");
const agentStatusEl = document.getElementById("agentStatus");

let agentLoaded = false;

async function loadAgentPrompt() {
  agentStatusEl.textContent = "Loading...";
  try {
    const res = await fetch("/api/agent-prompt");
    const data = await res.json();
    agentEditor.value = data.prompt;
    agentStatusEl.textContent = data.isSaved ? "Loaded saved version" : "Loaded default (not yet saved)";
    agentLoaded = true;
  } catch (err) {
    agentStatusEl.textContent = `Error loading: ${err.message}`;
  }
}

agentReloadBtn.addEventListener("click", () => {
  if (agentEditor.value && !confirm("Discard unsaved changes and reload?")) return;
  loadAgentPrompt();
});

agentSaveBtn.addEventListener("click", async () => {
  agentSaveBtn.disabled = true;
  agentStatusEl.textContent = "Saving...";
  try {
    const res = await fetch("/api/agent-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: agentEditor.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save");
    agentStatusEl.textContent = "Saved — live bot picks this up within about a minute.";
  } catch (err) {
    agentStatusEl.textContent = `Error saving: ${err.message}`;
  } finally {
    agentSaveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Test Bot
// ---------------------------------------------------------------------------
const testAdSelect = document.getElementById("testAdSelect");
const testResetBtn = document.getElementById("testResetBtn");
const testMessagesEl = document.getElementById("testMessages");
const testForm = document.getElementById("testForm");
const testInput = document.getElementById("testInput");

let testHistory = [];
let adOptionsLoaded = false;

async function loadAdOptions() {
  if (adOptionsLoaded) return;
  try {
    const res = await fetch("/api/ad-mapping");
    const rows = await res.json();
    for (const row of rows) {
      if (!row.ad_id) continue;
      const opt = document.createElement("option");
      opt.value = row.ad_id;
      opt.textContent = `${row.product_name || row.ad_id} (ad:${row.ad_id})`;
      testAdSelect.appendChild(opt);
    }
    adOptionsLoaded = true;
  } catch (err) {
    console.error("Failed to load ad mapping:", err);
  }
}

function renderTestThread() {
  testMessagesEl.innerHTML = "";
  if (testHistory.length === 0) {
    testMessagesEl.innerHTML = '<div class="empty-state">Send a message below to start testing.</div>';
    return;
  }
  for (const m of testHistory) {
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (m.role === "user" ? "incoming" : "outgoing");
    let html = escapeHtml(m.content);
    if (m.markers && m.markers.length) {
      html += `<span class="marker-badges">${m.markers
        .map((mk) => `<span class="marker-badge">${escapeHtml(mk)}</span>`)
        .join("")}</span>`;
    }
    bubble.innerHTML = html;
    testMessagesEl.appendChild(bubble);
  }
  testMessagesEl.scrollTop = testMessagesEl.scrollHeight;
}

testResetBtn.addEventListener("click", () => {
  testHistory = [];
  renderTestThread();
});

testForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = testInput.value.trim();
  if (!text) return;

  testHistory.push({ role: "user", content: text });
  renderTestThread();
  testInput.value = "";
  testInput.disabled = true;

  try {
    const res = await fetch("/api/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history: testHistory.map((m) => ({ role: m.role, content: m.content })),
        adId: testAdSelect.value || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed");

    const markers = [];
    if (data.escalated) markers.push("ESCALATED");
    if (data.offerClose) markers.push("OFFER_CLOSE queued");
    if (data.orderInfo) markers.push(`ORDER_INFO: ${data.orderInfo.name}`);

    testHistory.push({ role: "assistant", content: data.text || "(empty reply)", markers });
  } catch (err) {
    testHistory.push({ role: "assistant", content: `Error: ${err.message}`, markers: ["ERROR"] });
  } finally {
    testInput.disabled = false;
    testInput.focus();
    renderTestThread();
  }
});

// ---------------------------------------------------------------------------
// Escalated
// ---------------------------------------------------------------------------
const escalatedListEl = document.getElementById("escalatedList");
const escalatedHeaderTextEl = document.getElementById("escalatedHeaderText");
const escalatedMessagesEl = document.getElementById("escalatedMessages");
const replyForm = document.getElementById("replyForm");
const replyInput = document.getElementById("replyInput");
const resolveBtn = document.getElementById("resolveBtn");

let selectedEscalatedId = null;

function renderEscalatedList() {
  const escalated = customers.filter((c) => c.status === "Escalated");
  escalatedListEl.innerHTML = "";

  if (escalated.length === 0) {
    escalatedListEl.innerHTML = '<div class="empty-state">Nothing escalated right now.</div>';
    return;
  }

  for (const c of escalated) {
    const item = document.createElement("div");
    item.className = "customer-item" + (c.customer_id === selectedEscalatedId ? " active" : "");
    item.onclick = () => selectEscalated(c.customer_id, c.name);
    item.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(c.name || c.customer_id)}</span>
        <span class="badge escalated">Escalated</span>
      </div>
      <div class="meta">${escapeHtml(c.last_contact_date || "")}${c.last_ad_id ? ` · ad:${escapeHtml(c.last_ad_id)}` : ""}</div>
    `;
    escalatedListEl.appendChild(item);
  }
}

async function selectEscalated(customerId, name) {
  selectedEscalatedId = customerId;
  renderEscalatedList();
  escalatedHeaderTextEl.textContent = name || customerId;
  resolveBtn.hidden = false;
  replyForm.hidden = false;
  escalatedMessagesEl.innerHTML = '<div class="empty-state">Loading…</div>';

  const messages = await fetchMessages(customerId);
  renderEscalatedThread(messages);
}

function renderEscalatedThread(messages) {
  escalatedMessagesEl.innerHTML = "";
  if (messages.length === 0) {
    escalatedMessagesEl.innerHTML = '<div class="empty-state">No messages yet.</div>';
    return;
  }
  for (const m of messages) {
    const bubble = document.createElement("div");
    const isIncoming = m.direction === "Incoming";
    bubble.className = "bubble " + (isIncoming ? "incoming" : "outgoing");
    const handledBadge = m.handled_by === "Human" ? " · you" : "";
    bubble.innerHTML = `${escapeHtml(m.message_text || "")}<span class="timestamp">${escapeHtml(m.timestamp || "")}${handledBadge}</span>`;
    escalatedMessagesEl.appendChild(bubble);
  }
  escalatedMessagesEl.scrollTop = escalatedMessagesEl.scrollHeight;
}

resolveBtn.addEventListener("click", async () => {
  if (!selectedEscalatedId) return;
  await fetch(`/api/customers/${encodeURIComponent(selectedEscalatedId)}/resolve`, { method: "POST" });
  selectedEscalatedId = null;
  escalatedHeaderTextEl.textContent = "Select a conversation";
  escalatedMessagesEl.innerHTML = "";
  resolveBtn.hidden = true;
  replyForm.hidden = true;
  fetchCustomers();
});

replyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = replyInput.value.trim();
  if (!text || !selectedEscalatedId) return;

  replyInput.disabled = true;
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(selectedEscalatedId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send");
    replyInput.value = "";
    const messages = await fetchMessages(selectedEscalatedId);
    renderEscalatedThread(messages);
  } catch (err) {
    alert(`Failed to send: ${err.message}`);
  } finally {
    replyInput.disabled = false;
    replyInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
const ordersTableBody = document.getElementById("ordersTableBody");
const ORDER_STATUSES = ["New", "Confirmed", "Fulfilled", "Cancelled"];

async function fetchOrders() {
  const res = await fetch("/api/orders");
  const orders = await res.json();
  renderOrders(orders);
}

function renderOrders(orders) {
  ordersTableBody.innerHTML = "";
  if (orders.length === 0) {
    ordersTableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No orders yet.</td></tr>';
    return;
  }

  for (const o of orders) {
    const row = document.createElement("tr");
    const statusOptions = ORDER_STATUSES.map(
      (s) => `<option value="${s}" ${s === o.status ? "selected" : ""}>${s}</option>`
    ).join("");
    row.innerHTML = `
      <td>${escapeHtml(o.timestamp || "")}</td>
      <td>${escapeHtml(o.product_name || "")}</td>
      <td>${escapeHtml(o.customer_name || "")}</td>
      <td>${escapeHtml(o.phone || "")}</td>
      <td>${escapeHtml(o.address || "")}</td>
      <td>${escapeHtml(o.ad_id || "")}</td>
      <td><select class="status-select" data-order-id="${escapeHtml(o.order_id)}">${statusOptions}</select></td>
    `;
    ordersTableBody.appendChild(row);
  }

  ordersTableBody.querySelectorAll(".status-select").forEach((select) => {
    select.addEventListener("change", async () => {
      await fetch(`/api/orders/${encodeURIComponent(select.dataset.orderId)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: select.value }),
      });
    });
  });
}
