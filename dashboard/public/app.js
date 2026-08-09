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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

searchEl.addEventListener("input", renderCustomerList);
escalatedOnlyEl.addEventListener("change", renderCustomerList);

// Poll for updates so this behaves like a live monitor.
fetchCustomers();
setInterval(fetchCustomers, 15000);
setInterval(() => {
  if (selectedCustomerId) {
    fetchMessages(selectedCustomerId).then(renderThread);
  }
}, 15000);
