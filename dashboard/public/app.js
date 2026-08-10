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

// ---------------------------------------------------------------------------
// Product Images tab
// ---------------------------------------------------------------------------
const tabButtons = document.querySelectorAll(".tab-btn");
const viewChats = document.getElementById("view-chats");
const viewImages = document.getElementById("view-images");
const productCodeInput = document.getElementById("productCodeInput");
const fetchImagesBtn = document.getElementById("fetchImagesBtn");
const fetchStatusEl = document.getElementById("fetchStatus");
const fetchSummaryEl = document.getElementById("fetchSummary");
const pendingGridEl = document.getElementById("pendingGrid");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const isImages = btn.dataset.tab === "images";
    viewChats.hidden = isImages;
    viewImages.hidden = !isImages;
    if (isImages) fetchPendingImages();
  });
});

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
