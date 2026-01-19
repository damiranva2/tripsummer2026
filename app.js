/*
  Summer 2026 alikhan trip — FINAL app.js (Cloudflare Workers + KV)
  - Shared storage for everyone via Cloudflare Worker (NO GitHub API, NO rate limit)
  - Auto-save on every change (debounced)
  - Auto-refresh (poll) every 5 seconds
  - Fixed title + fixed dates (cannot be changed)
  - Light theme handled by styles.css (this is only JS)

  IMPORTANT: set API_URL to your Worker URL.
*/

const API_URL = "https://summer-2026-trip-api.damiryoubro.workers.dev/"; // <-- your Worker URL

const CONFIG = {
  TITLE_FIXED: "Summer 2026 alikhan trip",
  START_DATE: "2026-07-21",
  END_DATE: "2026-08-01",
  POLL_MS: 5000,       // realtime-ish refresh
  SAVE_DEBOUNCE_MS: 400
};

const LS_CLIENT_ID = "summer2026_trip_client_id_v1";

const $ = (sel) => document.querySelector(sel);

const ui = {
  // header/meta
  subtitle: $("#subtitle"),
  dateRangeBadge: $("#dateRangeBadge"),
  daysSubtitle: $("#daysSubtitle"),
  currency: $("#currency"),

  // budget KPIs
  kpiTotal: $("#kpiTotal"),
  kpiFlights: $("#kpiFlights"),
  kpiStay: $("#kpiStay"),
  kpiExpenses: $("#kpiExpenses"),

  // sync
  syncStatus: $("#syncStatus"),
  btnSaveNow: $("#btnSaveNow"),

  // legacy token UI (we hide it if exists)
  btnToken: $("#btnToken"),
  tokenPanel: $("#tokenPanel"),
  ghToken: $("#ghToken"),
  btnTest: $("#btnTest"),
  btnCloseToken: $("#btnCloseToken"),
  tokenStatus: $("#tokenStatus"),

  // lists
  days: $("#days"),
  flightsList: $("#flightsList"),
  staysList: $("#staysList"),
  expensesList: $("#expensesList"),
  addFlight: $("#addFlight"),
  addStay: $("#addStay"),
  addExpense: $("#addExpense"),
};

let state = null;

// sync flags
let saving = false;
let dirty = false;
let pollTimer = null;
let saveTimer = null;

// client identity (for debugging / lastUpdatedBy)
const clientId = getOrCreateClientId();

function getOrCreateClientId() {
  let id = localStorage.getItem(LS_CLIENT_ID);
  if (!id) {
    id = "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
    localStorage.setItem(LS_CLIENT_ID, id);
  }
  return id;
}

function nowTime() {
  return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setStatus(text) {
  if (ui.syncStatus) ui.syncStatus.textContent = text;
}

function formatMoney(value, currency) {
  const n = Number(value || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency} ${abs.toFixed(2)}`;
}

function isoToPretty(iso) {
  const d = new Date(iso + "T00:00:00");
  const opts = { weekday: "short", year: "numeric", month: "short", day: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

function* dateRange(startIso, endIso) {
  let d = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setDate(d.getDate() + 1);
  }
}

function defaultState() {
  return {
    meta: {
      title: CONFIG.TITLE_FIXED,
      currency: "USD",
      startDate: CONFIG.START_DATE,
      endDate: CONFIG.END_DATE,

      // internal sync hints
      _lastUpdated: 0,
      _lastUpdatedBy: "",
    },
    days: [],
    flights: [],
    stays: [],
    expenses: []
  };
}

function enforceFixedMeta() {
  state.meta = state.meta || {};
  state.meta.title = CONFIG.TITLE_FIXED;
  state.meta.startDate = CONFIG.START_DATE;
  state.meta.endDate = CONFIG.END_DATE;
  if (!state.meta.currency) state.meta.currency = "USD";

  // keep internal fields
  if (typeof state.meta._lastUpdated !== "number") state.meta._lastUpdated = 0;
  if (typeof state.meta._lastUpdatedBy !== "string") state.meta._lastUpdatedBy = "";
}

function ensureDays() {
  const wanted = Array.from(dateRange(CONFIG.START_DATE, CONFIG.END_DATE));
  const map = new Map((state.days || []).map(d => [d.date, d]));
  state.days = wanted.map(date => map.get(date) || { date, activities: [] });
}

function computeTotals() {
  const cur = state.meta.currency || "USD";
  const sum = (arr) => (arr || []).reduce((a, x) => a + Number(x.price || 0), 0);

  const flights = sum(state.flights);
  const stays = sum(state.stays);
  const expenses = sum(state.expenses);

  const total = flights + stays + expenses;

  if (ui.kpiFlights) ui.kpiFlights.textContent = formatMoney(flights, cur);
  if (ui.kpiStay) ui.kpiStay.textContent = formatMoney(stays, cur);
  if (ui.kpiExpenses) ui.kpiExpenses.textContent = formatMoney(expenses, cur);
  if (ui.kpiTotal) ui.kpiTotal.textContent = formatMoney(total, cur);
}

function renderMeta() {
  const start = new Date(CONFIG.START_DATE + "T00:00:00");
  const end = new Date(CONFIG.END_DATE + "T00:00:00");
  const opts = { month: "short", day: "numeric" };
  const year = start.getFullYear();

  if (ui.dateRangeBadge) {
    ui.dateRangeBadge.textContent = `${start.toLocaleDateString(undefined, opts)} — ${end.toLocaleDateString(undefined, opts)} ${year}`;
  }

  if (ui.daysSubtitle) {
    ui.daysSubtitle.textContent = `${CONFIG.START_DATE} → ${CONFIG.END_DATE} (${state.days.length} days)`;
  }

  if (ui.subtitle) {
    ui.subtitle.textContent = `Shared trip builder • API: Cloudflare KV • ${dirty ? "editing…" : "synced"}`;
  }

  if (ui.currency) ui.currency.value = state.meta.currency || "USD";
}

function makeThumb(url) {
  const el = document.createElement("div");
  el.className = "thumb";
  if (!url) { el.textContent = "img"; return el; }
  const img = document.createElement("img");
  img.src = url;
  img.alt = "image";
  img.loading = "lazy";
  el.appendChild(img);
  return el;
}

function itemTemplate({ title, price, link, image, note }, onChange, onDelete) {
  const wrap = document.createElement("div");
  wrap.className = "item";

  const thumb = makeThumb(image);
  wrap.appendChild(thumb);

  const content = document.createElement("div");
  content.className = "content";

  const row1 = document.createElement("div");
  row1.className = "row gap";

  const fTitle = document.createElement("label");
  fTitle.className = "field";
  fTitle.innerHTML = `<span>Title</span>`;
  const inTitle = document.createElement("input");
  inTitle.value = title || "";
  inTitle.addEventListener("input", () => { onChange({ title: inTitle.value }); scheduleSave(); });
  fTitle.appendChild(inTitle);

  const fPrice = document.createElement("label");
  fPrice.className = "field compact";
  fPrice.innerHTML = `<span>Price</span>`;
  const inPrice = document.createElement("input");
  inPrice.type = "number";
  inPrice.step = "0.01";
  inPrice.value = price ?? "";
  inPrice.addEventListener("input", () => {
    onChange({ price: Number(inPrice.value || 0) });
    scheduleSave();
    renderAll(false);
  });
  fPrice.appendChild(inPrice);

  row1.appendChild(fTitle);
  row1.appendChild(fPrice);

  const row2 = document.createElement("div");
  row2.className = "row gap";

  const fLink = document.createElement("label");
  fLink.className = "field";
  fLink.innerHTML = `<span>Link</span>`;
  const inLink = document.createElement("input");
  inLink.value = link || "";
  inLink.addEventListener("input", () => { onChange({ link: inLink.value }); scheduleSave(); });
  fLink.appendChild(inLink);

  const fImg = document.createElement("label");
  fImg.className = "field";
  fImg.innerHTML = `<span>Image URL</span>`;
  const inImg = document.createElement("input");
  inImg.value = image || "";
  inImg.addEventListener("input", () => { onChange({ image: inImg.value }); scheduleSave(); });
  fImg.appendChild(inImg);

  row2.appendChild(fLink);
  row2.appendChild(fImg);

  const fNote = document.createElement("label");
  fNote.className = "field";
  fNote.innerHTML = `<span>Notes</span>`;
  const inNote = document.createElement("textarea");
  inNote.value = note || "";
  inNote.addEventListener("input", () => { onChange({ note: inNote.value }); scheduleSave(); });
  fNote.appendChild(inNote);

  content.appendChild(row1);
  content.appendChild(row2);
  content.appendChild(fNote);
  wrap.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "actions";

  const aOpen = document.createElement("a");
  aOpen.className = "btn";
  aOpen.textContent = "Open";
  aOpen.href = link || "#";
  aOpen.target = "_blank";
  aOpen.rel = "noopener noreferrer";
  aOpen.addEventListener("click", (e) => { if (!link) e.preventDefault(); });

  const bDel = document.createElement("button");
  bDel.className = "btn danger";
  bDel.type = "button";
  bDel.textContent = "Delete";
  bDel.addEventListener("click", () => { onDelete(); scheduleSave(); renderAll(); });

  actions.appendChild(aOpen);
  actions.appendChild(bDel);
  wrap.appendChild(actions);

  inImg.addEventListener("change", () => {
    wrap.replaceChild(makeThumb(inImg.value.trim()), thumb);
  });

  return wrap;
}

function renderFlights() {
  if (!ui.flightsList) return;
  ui.flightsList.innerHTML = "";
  (state.flights || []).forEach((f, idx) => {
    ui.flightsList.appendChild(
      itemTemplate(
        f,
        (patch) => Object.assign(state.flights[idx], patch),
        () => state.flights.splice(idx, 1)
      )
    );
  });
}

function renderStays() {
  if (!ui.staysList) return;
  ui.staysList.innerHTML = "";
  (state.stays || []).forEach((s, idx) => {
    ui.staysList.appendChild(
      itemTemplate(
        s,
        (patch) => Object.assign(state.stays[idx], patch),
        () => state.stays.splice(idx, 1)
      )
    );
  });
}

function renderExpenses() {
  if (!ui.expensesList) return;
  ui.expensesList.innerHTML = "";

  (state.expenses || []).forEach((x, idx) => {
    const el = document.createElement("div");
    el.className = "item";

    const thumb = makeThumb(x.image);
    el.appendChild(thumb);

    const content = document.createElement("div");
    content.className = "content";

    const row1 = document.createElement("div");
    row1.className = "row gap";

    const fTitle = document.createElement("label");
    fTitle.className = "field";
    fTitle.innerHTML = `<span>Title</span>`;
    const inTitle = document.createElement("input");
    inTitle.value = x.title || "";
    inTitle.addEventListener("input", () => { x.title = inTitle.value; scheduleSave(); });
    fTitle.appendChild(inTitle);

    const fCat = document.createElement("label");
    fCat.className = "field compact";
    fCat.innerHTML = `<span>Category</span>`;
    const inCat = document.createElement("input");
    inCat.value = x.category || "";
    inCat.addEventListener("input", () => { x.category = inCat.value; scheduleSave(); });
    fCat.appendChild(inCat);

    const fPrice = document.createElement("label");
    fPrice.className = "field compact";
    fPrice.innerHTML = `<span>Price</span>`;
    const inPrice = document.createElement("input");
    inPrice.type = "number";
    inPrice.step = "0.01";
    inPrice.value = x.price ?? "";
    inPrice.addEventListener("input", () => { x.price = Number(inPrice.value || 0); scheduleSave(); renderAll(false); });
    fPrice.appendChild(inPrice);

    row1.appendChild(fTitle);
    row1.appendChild(fCat);
    row1.appendChild(fPrice);

    const row2 = document.createElement("div");
    row2.className = "row gap";

    const fDay = document.createElement("label");
    fDay.className = "field compact";
    fDay.innerHTML = `<span>Day (optional)</span>`;
    const selDay = document.createElement("select");
    const opt0 = document.createElement("option");
    opt0.value = ""; opt0.textContent = "—";
    selDay.appendChild(opt0);
    state.days.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.date;
      opt.textContent = d.date;
      selDay.appendChild(opt);
    });
    selDay.value = x.day || "";
    selDay.addEventListener("change", () => { x.day = selDay.value || ""; scheduleSave(); });
    fDay.appendChild(selDay);

    const fLink = document.createElement("label");
    fLink.className = "field";
    fLink.innerHTML = `<span>Link</span>`;
    const inLink = document.createElement("input");
    inLink.value = x.link || "";
    inLink.addEventListener("input", () => { x.link = inLink.value; scheduleSave(); });
    fLink.appendChild(inLink);

    const fImg = document.createElement("label");
    fImg.className = "field";
    fImg.innerHTML = `<span>Image URL</span>`;
    const inImg = document.createElement("input");
    inImg.value = x.image || "";
    inImg.addEventListener("input", () => { x.image = inImg.value; scheduleSave(); });
    fImg.appendChild(inImg);

    row2.appendChild(fDay);
    row2.appendChild(fLink);
    row2.appendChild(fImg);

    const fNote = document.createElement("label");
    fNote.className = "field";
    fNote.innerHTML = `<span>Notes</span>`;
    const inNote = document.createElement("textarea");
    inNote.value = x.note || "";
    inNote.addEventListener("input", () => { x.note = inNote.value; scheduleSave(); });
    fNote.appendChild(inNote);

    content.appendChild(row1);
    content.appendChild(row2);
    content.appendChild(fNote);

    el.appendChild(content);

    const actions = document.createElement("div");
    actions.className = "actions";

    const aOpen = document.createElement("a");
    aOpen.className = "btn";
    aOpen.textContent = "Open";
    aOpen.href = x.link || "#";
    aOpen.target = "_blank";
    aOpen.rel = "noopener noreferrer";
    aOpen.addEventListener("click", (e) => { if (!x.link) e.preventDefault(); });

    const bDel = document.createElement("button");
    bDel.className = "btn danger";
    bDel.type = "button";
    bDel.textContent = "Delete";
    bDel.addEventListener("click", () => {
      state.expenses.splice(idx, 1);
      scheduleSave();
      renderAll();
    });

    actions.appendChild(aOpen);
    actions.appendChild(bDel);
    el.appendChild(actions);

    inImg.addEventListener("change", () => {
      el.replaceChild(makeThumb(inImg.value.trim()), thumb);
    });

    ui.expensesList.appendChild(el);
  });
}

function renderDays() {
  if (!ui.days) return;
  ui.days.innerHTML = "";

  state.days.forEach((d, dayIdx) => {
    const box = document.createElement("div");
    box.className = "day";

    const head = document.createElement("div");
    head.className = "day-head";

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="day-title">Day ${dayIdx + 1}</div>
      <div class="day-date">${isoToPretty(d.date)} <span class="small">(${d.date})</span></div>
    `;

    const btnAdd = document.createElement("button");
    btnAdd.className = "btn primary";
    btnAdd.type = "button";
    btnAdd.textContent = "+ Add activity";
    btnAdd.addEventListener("click", () => {
      d.activities.push({
        title: "New activity",
        time: "",
        price: 0,
        link: "",
        image: "",
        note: ""
      });
      scheduleSave();
      renderAll();
    });

    head.appendChild(left);
    head.appendChild(btnAdd);

    const acts = document.createElement("div");
    acts.className = "activities";

    d.activities.forEach((a, idx) => {
      const row = document.createElement("div");
      row.className = "activity";

      const thumb = makeThumb(a.image);
      row.appendChild(thumb);

      const content = document.createElement("div");
      content.className = "content";

      const r1 = document.createElement("div");
      r1.className = "row gap";

      const fTitle = document.createElement("label");
      fTitle.className = "field";
      fTitle.innerHTML = `<span>Activity</span>`;
      const inTitle = document.createElement("input");
      inTitle.value = a.title || "";
      inTitle.addEventListener("input", () => { a.title = inTitle.value; scheduleSave(); });
      fTitle.appendChild(inTitle);

      const fTime = document.createElement("label");
      fTime.className = "field compact";
      fTime.innerHTML = `<span>Time</span>`;
      const inTime = document.createElement("input");
      inTime.placeholder = "например 10:30";
      inTime.value = a.time || "";
      inTime.addEventListener("input", () => { a.time = inTime.value; scheduleSave(); });
      fTime.appendChild(inTime);

      const fPrice = document.createElement("label");
      fPrice.className = "field compact";
      fPrice.innerHTML = `<span>Cost</span>`;
      const inPrice = document.createElement("input");
      inPrice.type = "number";
      inPrice.step = "0.01";
      inPrice.value = a.price ?? "";
      inPrice.addEventListener("input", () => { a.price = Number(inPrice.value || 0); scheduleSave(); renderAll(false); });
      fPrice.appendChild(inPrice);

      r1.appendChild(fTitle);
      r1.appendChild(fTime);
      r1.appendChild(fPrice);

      const r2 = document.createElement("div");
      r2.className = "row gap";

      const fLink = document.createElement("label");
      fLink.className = "field";
      fLink.innerHTML = `<span>Link</span>`;
      const inLink = document.createElement("input");
      inLink.value = a.link || "";
      inLink.addEventListener("input", () => { a.link = inLink.value; scheduleSave(); });
      fLink.appendChild(inLink);

      const fImg = document.createElement("label");
      fImg.className = "field";
      fImg.innerHTML = `<span>Image URL</span>`;
      const inImg = document.createElement("input");
      inImg.value = a.image || "";
      inImg.addEventListener("input", () => { a.image = inImg.value; scheduleSave(); });
      fImg.appendChild(inImg);

      r2.appendChild(fLink);
      r2.appendChild(fImg);

      const fNote = document.createElement("label");
      fNote.className = "field";
      fNote.innerHTML = `<span>Notes</span>`;
      const inNote = document.createElement("textarea");
      inNote.value = a.note || "";
      inNote.addEventListener("input", () => { a.note = inNote.value; scheduleSave(); });
      fNote.appendChild(inNote);

      const r3 = document.createElement("div");
      r3.className = "row gap";

      const open = document.createElement("a");
      open.className = "btn";
      open.textContent = "Open";
      open.href = a.link || "#";
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.addEventListener("click", (e) => { if (!a.link) e.preventDefault(); });

      const del = document.createElement("button");
      del.className = "btn danger";
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        d.activities.splice(idx, 1);
        scheduleSave();
        renderAll();
      });

      r3.appendChild(open);
      r3.appendChild(del);

      content.appendChild(r1);
      content.appendChild(r2);
      content.appendChild(fNote);
      content.appendChild(r3);

      row.appendChild(content);

      inImg.addEventListener("change", () => {
        row.replaceChild(makeThumb(inImg.value.trim()), thumb);
      });

      acts.appendChild(row);
    });

    box.appendChild(head);
    box.appendChild(acts);
    ui.days.appendChild(box);
  });
}

function renderAll(full = true) {
  enforceFixedMeta();
  ensureDays();
  renderMeta();
  computeTotals();

  if (full) {
    renderFlights();
    renderStays();
    renderExpenses();
    renderDays();
  }
}

/* ------------------------------
   Cloudflare API
-------------------------------- */

async function loadRemote() {
  const res = await fetch(API_URL, { method: "GET" });
  if (!res.ok) throw new Error(`API GET ${res.status}`);
  return await res.json();
}

async function saveRemote() {
  const res = await fetch(API_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  if (!res.ok) throw new Error(`API PUT ${res.status}`);
}

/* ------------------------------
   Autosave + Poll
-------------------------------- */

function markDirty() {
  dirty = true;
  setStatus(`Unsaved changes… (${nowTime()})`);
}

function clearDirtySaved() {
  dirty = false;
  setStatus(`Saved ✅ (${nowTime()})`);
}

function scheduleSave() {
  markDirty();

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow().catch(err => setStatus(`Save error: ${err.message}`));
  }, CONFIG.SAVE_DEBOUNCE_MS);
}

async function saveNow() {
  if (!state) return;
  if (saving) return;

  saving = true;
  try {
    enforceFixedMeta();
    ensureDays();

    // write sync markers (helps polling logic)
    state.meta._lastUpdated = Date.now();
    state.meta._lastUpdatedBy = clientId;

    await saveRemote();
    clearDirtySaved();
  } finally {
    saving = false;
  }
}

async function pollOnce() {
  // Don't overwrite while user is typing or while saving
  if (saving || dirty) return;

  try {
    const remote = await loadRemote();

    // First time: adopt remote
    if (!state) {
      state = remote;
      renderAll();
      setStatus(`Loaded ✅ (${nowTime()})`);
      return;
    }

    const localTs = Number(state?.meta?._lastUpdated || 0);
    const remoteTs = Number(remote?.meta?._lastUpdated || 0);

    // If remote has newer data, update local
    if (remoteTs > localTs) {
      state = remote;
      renderAll();
      setStatus(`Updated from server 🔄 (${nowTime()})`);
    } else {
      setStatus(`Synced ✅ (${nowTime()})`);
    }
  } catch (e) {
    setStatus(`Sync error: ${e.message}`);
  }
}

/* ------------------------------
   Init + UI bindings
-------------------------------- */

function hideLegacyTokenUI() {
  // We no longer need tokens at all with Cloudflare KV
  if (ui.btnToken) ui.btnToken.style.display = "none";
  if (ui.tokenPanel) ui.tokenPanel.style.display = "none";
}

async function init() {
  hideLegacyTokenUI();

  setStatus("Loading from Cloudflare…");
  try {
    state = await loadRemote();
  } catch (e) {
    // If API fails, still let UI work locally (not shared)
    state = defaultState();
    setStatus(`Cannot load API, using local fallback: ${e.message}`);
  }

  renderAll(true);
  setStatus(`Loaded ✅ (${nowTime()})`);

  // Currency change
  if (ui.currency) {
    ui.currency.addEventListener("change", () => {
      state.meta.currency = ui.currency.value;
      scheduleSave();
      renderAll(false);
    });
  }

  // Buttons
  if (ui.btnSaveNow) {
    ui.btnSaveNow.addEventListener("click", () => {
      saveNow().catch(err => setStatus(`Save error: ${err.message}`));
    });
  }

  if (ui.addFlight) {
    ui.addFlight.addEventListener("click", () => {
      state.flights.push({ title: "Flight", price: 0, link: "", image: "", note: "" });
      scheduleSave();
      renderAll();
    });
  }

  if (ui.addStay) {
    ui.addStay.addEventListener("click", () => {
      state.stays.push({ title: "Stay", price: 0, link: "", image: "", note: "" });
      scheduleSave();
      renderAll();
    });
  }

  if (ui.addExpense) {
    ui.addExpense.addEventListener("click", () => {
      state.expenses.push({ title: "Expense", category: "", day: "", price: 0, link: "", image: "", note: "" });
      scheduleSave();
      renderAll();
    });
  }

  // Poll for shared updates
  pollTimer = setInterval(() => pollOnce(), CONFIG.POLL_MS);
  setTimeout(() => pollOnce(), 1500);
}

init().catch(err => setStatus(`Init error: ${err.message}`));
