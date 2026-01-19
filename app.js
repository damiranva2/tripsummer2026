/*
  Summer 2026 alikhan trip
  - Always "Shared mode": reads/writes trip-data.json in GitHub repo
  - Auto-refresh: every 10 seconds pulls latest
  - Auto-save: every change is saved (debounced)
  - Title is fixed (cannot be edited)
  - GitHub Pages compatible (no servers)
*/

const CONFIG = {
  OWNER: "damiranva2",          // <-- поменяй
  REPO: "tripsummer2026",                 // <-- поменяй
  BRANCH: "main",
  PATH: "trip-data.json",
  TITLE_FIXED: "Summer 2026 alikhan trip",
  START_DATE: "2026-07-21",
  END_DATE: "2026-08-01",
  POLL_MS: 10000
};

const LS_TOKEN = "summer2026_trip_gh_token_v1";

const $ = (sel) => document.querySelector(sel);

const ui = {
  subtitle: $("#subtitle"),
  dateRangeBadge: $("#dateRangeBadge"),
  daysSubtitle: $("#daysSubtitle"),
  currency: $("#currency"),

  kpiTotal: $("#kpiTotal"),
  kpiFlights: $("#kpiFlights"),
  kpiStay: $("#kpiStay"),
  kpiExpenses: $("#kpiExpenses"),

  syncStatus: $("#syncStatus"),
  btnSaveNow: $("#btnSaveNow"),
  btnToken: $("#btnToken"),

  tokenPanel: $("#tokenPanel"),
  ghToken: $("#ghToken"),
  btnTest: $("#btnTest"),
  btnCloseToken: $("#btnCloseToken"),
  tokenStatus: $("#tokenStatus"),

  days: $("#days"),
  flightsList: $("#flightsList"),
  staysList: $("#staysList"),
  expensesList: $("#expensesList"),
  addFlight: $("#addFlight"),
  addStay: $("#addStay"),
  addExpense: $("#addExpense"),
};

let state = null;
let lastRemoteSha = null;
let saveTimer = null;
let saving = false;
let dirty = false;
let polling = null;

function nowTime() {
  return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setStatus(text) {
  ui.syncStatus.textContent = text;
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
      endDate: CONFIG.END_DATE
    },
    days: [],
    flights: [],
    stays: [],
    expenses: []
  };
}

function ensureDays() {
  const wanted = Array.from(dateRange(CONFIG.START_DATE, CONFIG.END_DATE));
  const map = new Map((state.days || []).map(d => [d.date, d]));
  state.days = wanted.map(date => map.get(date) || { date, activities: [] });
}

function enforceFixedMeta() {
  state.meta = state.meta || {};
  state.meta.title = CONFIG.TITLE_FIXED;
  state.meta.startDate = CONFIG.START_DATE;
  state.meta.endDate = CONFIG.END_DATE;
  state.meta.currency = state.meta.currency || "USD";
}

function computeTotals() {
  const cur = state.meta.currency || "USD";
  const sum = (arr) => (arr || []).reduce((a, x) => a + Number(x.price || 0), 0);

  const flights = sum(state.flights);
  const stays = sum(state.stays);
  const expenses = sum(state.expenses);

  const total = flights + stays + expenses;

  ui.kpiFlights.textContent = formatMoney(flights, cur);
  ui.kpiStay.textContent = formatMoney(stays, cur);
  ui.kpiExpenses.textContent = formatMoney(expenses, cur);
  ui.kpiTotal.textContent = formatMoney(total, cur);
}

function renderMeta() {
  const start = new Date(CONFIG.START_DATE + "T00:00:00");
  const end = new Date(CONFIG.END_DATE + "T00:00:00");
  const opts = { month: "short", day: "numeric" };
  ui.dateRangeBadge.textContent = `${start.toLocaleDateString(undefined, opts)} — ${end.toLocaleDateString(undefined, opts)} ${start.getFullYear()}`;
  ui.daysSubtitle.textContent = `${CONFIG.START_DATE} → ${CONFIG.END_DATE} (${state.days.length} days)`;
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

function scheduleSave() {
  dirty = true;
  setStatus(`Unsaved changes… (${nowTime()})`);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow().catch(err => {
    setStatus(`Save error: ${err.message}`);
  }), 350);
}

function sanitize(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getToken() {
  return (ui.ghToken.value || localStorage.getItem(LS_TOKEN) || "").trim();
}

function setToken(v) {
  ui.ghToken.value = v || "";
  if (v) localStorage.setItem(LS_TOKEN, v);
  else localStorage.removeItem(LS_TOKEN);
}

// ---------- GitHub API ----------
async function ghRequest(url, { method="GET", token="", body=null } = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = (json && json.message) ? json.message : text;
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }
  return json;
}

function contentsUrl() {
  return `https://api.github.com/repos/${CONFIG.OWNER}/${CONFIG.REPO}/contents/${encodeURIComponent(CONFIG.PATH)}?ref=${encodeURIComponent(CONFIG.BRANCH)}`;
}

async function loadRemote({ token = "" } = {}) {
  const data = await ghRequest(contentsUrl(), { token });
  const sha = data.sha;
  const content = atob((data.content || "").replace(/\n/g, ""));
  const json = JSON.parse(content);
  return { sha, json };
}

async function saveRemote({ token }) {
  const payload = sanitize(state);
  const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  const url = `https://api.github.com/repos/${CONFIG.OWNER}/${CONFIG.REPO}/contents/${encodeURIComponent(CONFIG.PATH)}`;

  const body = {
    message: `Update trip data (${new Date().toISOString()})`,
    content: contentB64,
    branch: CONFIG.BRANCH
  };
  if (lastRemoteSha) body.sha = lastRemoteSha;

  const res = await ghRequest(url, { method: "PUT", token, body });
  if (res?.content?.sha) lastRemoteSha = res.content.sha;
}

async function saveNow() {
  if (!state) return;
  if (saving) return;

  const token = getToken();
  if (!token) {
    // no token => read-only
    dirty = false; // we still allow UI editing, but cannot persist globally
    setStatus(`Read-only (no token). Changes won't save for everyone.`);
    return;
  }

  saving = true;
  try {
    enforceFixedMeta();
    ensureDays();
    computeTotals();

    // Try save with current sha. If conflict -> reload and retry once (last-writer-wins).
    try {
      await saveRemote({ token });
    } catch (e) {
      const isConflict = String(e.message).includes("409");
      if (!isConflict) throw e;

      // reload latest then overwrite (last writer wins)
      const remote = await loadRemote({ token });
      lastRemoteSha = remote.sha;
      await saveRemote({ token });
    }

    dirty = false;
    setStatus(`Saved ✅ (${nowTime()})`);
  } finally {
    saving = false;
  }
}

// ---------- UI rendering ----------
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
  inPrice.addEventListener("input", () => { onChange({ price: Number(inPrice.value || 0) }); scheduleSave(); renderAll(false); });
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
    bDel.addEventListener("click", () => { state.expenses.splice(idx, 1); scheduleSave(); renderAll(); });

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

async function pollOnce() {
  try {
    // For frequent polling we strongly prefer token (rate limit).
    // If no token, we still try, but can hit rate limit.
    const token = getToken();
    const remote = await loadRemote({ token });

    // init sha
    if (!lastRemoteSha) lastRemoteSha = remote.sha;

    // if changed on server
    if (remote.sha !== lastRemoteSha) {
      if (!dirty && !saving) {
        state = remote.json;
        lastRemoteSha = remote.sha;
        renderAll();
        setStatus(`Updated from server 🔄 (${nowTime()})`);
      } else {
        // user has unsaved changes -> do not overwrite, but inform
        setStatus(`Server updated, but you have local changes… (${nowTime()})`);
      }
    } else {
      // no change
      if (!dirty) setStatus(`Synced ✅ (${nowTime()})`);
    }
  } catch (e) {
    setStatus(`Sync error: ${e.message}`);
  }
}

async function testConnection() {
  ui.tokenStatus.textContent = "Testing…";
  try {
    const token = getToken();
    if (!token) throw new Error("No token");
    const remote = await loadRemote({ token });
    lastRemoteSha = remote.sha;
    ui.tokenStatus.textContent = "OK ✅ Can read";
  } catch (e) {
    ui.tokenStatus.textContent = e.message;
  }
}

async function init() {
  // token UI
  setToken(localStorage.getItem(LS_TOKEN) || "");
  ui.btnToken.addEventListener("click", () => ui.tokenPanel.hidden = !ui.tokenPanel.hidden);
  ui.btnCloseToken.addEventListener("click", () => ui.tokenPanel.hidden = true);

  ui.ghToken.addEventListener("input", () => {
    setToken(ui.ghToken.value.trim());
  });
  ui.btnTest.addEventListener("click", () => testConnection());

  ui.btnSaveNow.addEventListener("click", () => saveNow().catch(e => setStatus(`Save error: ${e.message}`)));

  // Load initial remote state
  setStatus("Loading from GitHub…");
  try {
    const token = getToken();
    const remote = await loadRemote({ token });
    state = remote.json;
    lastRemoteSha = remote.sha;
    renderAll();
    setStatus(`Loaded ✅ (${nowTime()})`);
  } catch (e) {
    // if cannot load remote -> fallback local default (still works UI)
    state = defaultState();
    renderAll();
    setStatus(`Cannot load remote: ${e.message}`);
  }

  // bindings
  ui.currency.addEventListener("change", () => {
    state.meta.currency = ui.currency.value;
    scheduleSave();
    renderAll(false);
  });

  ui.addFlight.addEventListener("click", () => {
    state.flights.push({ title: "Flight", price: 0, link: "", image: "", note: "" });
    scheduleSave(); renderAll();
  });
  ui.addStay.addEventListener("click", () => {
    state.stays.push({ title: "Stay", price: 0, link: "", image: "", note: "" });
    scheduleSave(); renderAll();
  });
  ui.addExpense.addEventListener("click", () => {
    state.expenses.push({ title: "Expense", category: "", day: "", price: 0, link: "", image: "", note: "" });
    scheduleSave(); renderAll();
  });

  // start polling every 10s
  polling = setInterval(() => pollOnce(), CONFIG.POLL_MS);
  // also do one extra poll shortly after load
  setTimeout(() => pollOnce(), 2000);
}

init().catch(err => setStatus(`Init error: ${err.message}`));

