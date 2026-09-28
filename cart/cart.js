/* Cart for the static digital menus. Shared by every restaurant: nothing restaurant-specific lives here.
 *
 * Each restaurant page:
 *   1. Defines window.MENU_CONFIG before this script loads (see darios/index.html for the fields).
 *   2. Marks each orderable item with data attributes:
 *        data-cart-id="italian/dolce/tiramisu"  data-cart-name="Tiramisu"  data-cart-price="400"
 *        data-cart-variants='[{"label":"Red","price":500},{"label":"White","price":500}]'   (optional)
 *      An item with an empty data-cart-price and no variants can't be ordered (e.g. "ask your server").
 *   3. Loads cart.css and this file.
 *   4. Optionally has an element with a data-cart-table attribute (kept hidden) where "Table 12" is shown.
 *
 * The table comes from the link, e.g. .../darios/?table=12 (numbers or short codes like T12 or B3).
 * Each table gets its own saved cart. With no table in the link guests can still browse and build an
 * order; they're asked for their table number when they place it.
 *
 * Where orders go: with MENU_CONFIG.firebase set, they're saved to Firestore (orders-firebase.js) and the guest
 * sees live status as staff update it on the staff screen. Otherwise with orderWebhookUrl they're POSTed there,
 * and with neither they're only logged.
 *
 * Today's code (Firebase only, MENU_CONFIG.dailyCode): staff get a 4-digit code on the staff screen each day;
 * guests enter it once at checkout and it's remembered until the daily reset. The Firestore rules reject orders
 * with a wrong or expired code, so a photo of a table's QR code can't be used to order from home.
 * Staff can also pause ordering; the menu then stays browsable but can't take orders.
 *
 * Menus that re-render their items (tabs, search, filters) are fine: a MutationObserver re-adds the
 * controls every time the item list changes. With orderingEnabled anything but true, this file does nothing.
 */
(() => {
  "use strict";
  const C = window.MENU_CONFIG;
  if (!C || C.orderingEnabled !== true) return;
  const CART_SRC = document.currentScript ? document.currentScript.src : location.href;

  const STORE_PREFIX = "cart:" + (C.restaurantId || location.pathname);
  const MAX_QTY = 20;
  const servicePct = Number(C.serviceChargePercent) || 0;
  const soldOut = new Set(C.soldOut || []);
  const doc = document.documentElement;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => (C.currency || "₹") + Math.round(n).toLocaleString(C.locale || "en-IN");
  const lineKey = (id, variant) => (variant ? id + "|" + variant : id);
  const isSoldOut = (id, name) => soldOut.has(id) || soldOut.has(name);

  /* ---------- Table ---------- */

  // "12", "T12", "b3", "Table 12", "T-12" are fine; returns "12" / "T12" / "B3", or null for anything else
  function cleanTable(raw) {
    if (typeof raw !== "string") return null;
    const t = raw.trim().toUpperCase().replace(/^TABLE\s*/, "").replace(/[\s#-]/g, "");
    return /^[A-Z]{0,3}\d{1,4}$/.test(t) ? t : null;
  }
  let table = null;
  try {
    const raw = new URLSearchParams(location.search).get("table");
    table = cleanTable(raw);
    if (raw != null && !table) console.warn("[cart] Ignoring table in the link, not a table number:", raw);
  } catch (_) {}
  const storeKey = () => STORE_PREFIX + (table ? ":" + table : "");

  /* ---------- Orders this phone has placed (for live status) ---------- */

  const STATUS = {
    new:       { label: "Sent",           note: "Waiting for the restaurant to accept your order." },
    accepted:  { label: "Accepted",       note: "The restaurant has your order." },
    preparing: { label: "Being prepared", note: "The kitchen is preparing your order." },
    served:    { label: "Served",         note: "Enjoy your meal!" },
    cancelled: { label: "Cancelled",      note: "This order was cancelled. Please ask your server." }
  };
  const STEPS = ["new", "accepted", "preparing", "served"];
  const FINAL = ["served", "cancelled"];
  const KEEP_MS = 8 * 3600e3;          // forget orders after 8 hours
  const SHOW_FINAL_MS = 15 * 60e3;     // keep showing a served or cancelled order for 15 minutes

  const trackKey = () => "orders:" + (C.restaurantId || location.pathname) + (table ? ":" + table : "");
  let tracked = [];                    // { id, code, table, at, status, statusAt }, newest first
  const watching = new Map();          // order id -> function that stops watching

  function loadTracked() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(trackKey()) || "[]"); } catch (_) {}
    tracked = (Array.isArray(list) ? list : []).filter(o => o && typeof o.id === "string" && Date.now() - o.at < KEEP_MS);
  }
  function saveTracked() {
    try { localStorage.setItem(trackKey(), JSON.stringify(tracked)); } catch (_) {}
  }
  // Orders worth showing the guest: still in progress, or finished in the last few minutes
  const activeOrders = () => tracked.filter(o => !FINAL.includes(o.status) || Date.now() - (o.statusAt || o.at) < SHOW_FINAL_MS);

  /* ---------- Today's code and the pause switch ---------- */

  const codeRequired = () => !!C.firebase && C.dailyCode !== false;
  const CODE_KEY = "code:" + (C.restaurantId || location.pathname);
  // The code is remembered until the next daily reset (5 am by default), when staff get a new one
  function nextReset() {
    const hour = Number.isInteger(C.dailyCodeResetHour) ? C.dailyCodeResetHour : 5;
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  let dailyCode = null;
  try {
    const saved = JSON.parse(localStorage.getItem(CODE_KEY) || "null");
    if (saved && /^\d{4}$/.test(saved.code) && Date.now() < saved.until) dailyCode = saved.code;
  } catch (_) {}
  function rememberCode(code) {
    dailyCode = code;
    try {
      if (code) localStorage.setItem(CODE_KEY, JSON.stringify({ code, until: nextReset() }));
      else localStorage.removeItem(CODE_KEY);
    } catch (_) {}
  }

  let paused = false;
  function watchPause() {
    if (!C.firebase) return;
    firebase().then(fb => fb.watchOrdering(C, ({ paused: p }) => {
      if (p === paused) return;
      paused = p;
      doc.classList.toggle("cart-paused", paused);
      live.textContent = paused ? "Ordering is paused. Please order with your server." : "Ordering is open again.";
      refresh();
      paintGate();
    })).catch(err => console.warn("[cart] Couldn't load ordering status:", err));
  }

  /* ---------- Welcome screen: today's code as soon as the menu opens ---------- */

  // Shown when the menu opens without a remembered code. The code is checked with Firebase straight away,
  // so a wrong code is caught before the guest builds an order. "Just look at the menu" lets people browse;
  // they're then asked for the code at checkout instead.
  const GATE_SKIP_KEY = "gate-skipped:" + (C.restaurantId || location.pathname);
  let gate = null, gateBusy = false, gateError = "";
  function gateSkipped() {
    try { return sessionStorage.getItem(GATE_SKIP_KEY) === "1"; } catch (_) { return false; }
  }
  const gateWanted = () => codeRequired() && !dailyCode && !gateSkipped();

  function openGate() {
    gate = document.createElement("div");
    gate.className = "cart-gate";
    gate.innerHTML = '<div class="cart-gate-card" role="dialog" aria-modal="true" aria-labelledby="cart-gate-title">'
      + `<p class="cart-gate-hello">Welcome to</p><h2 id="cart-gate-title" tabindex="-1">${esc(C.restaurantName || "our menu")}</h2>`
      + '<div class="cart-gate-body"></div></div>';
    document.body.append(gate);
    doc.classList.add("cart-lock");
    paintGate();
    (gate.querySelector("input") || gate.querySelector("h2")).focus();
  }

  function paintGate() {
    if (!gate) return;
    const body = gate.querySelector(".cart-gate-body");
    const pill = table ? `<p class="cart-table-pill">Table ${esc(table)}</p>` : "";
    if (paused) {
      body.innerHTML = pill + '<p class="cart-gate-lead">Ordering is paused right now. Please order with your server.</p>'
        + '<button type="button" class="cart-primary" data-cart-act="gate-skip">See the menu</button>';
      return;
    }
    if (!body.querySelector("form")) {
      body.innerHTML = pill + '<form class="cart-gate-form" novalidate>'
        + (table ? "" : '<label for="gate-table">Your table number</label>'
          + '<input id="gate-table" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="10" placeholder="For example: 12">')
        + '<label for="gate-code">Today’s code</label>'
        + '<input id="gate-code" class="cart-gate-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="4" placeholder="• • • •" aria-describedby="gate-hint gate-err">'
        + '<p id="gate-hint" class="cart-gate-hint">Ask your server for today’s code, or check the card on your table.</p>'
        + '<p id="gate-err" class="cart-ask-err" role="alert"></p>'
        + '<button type="submit" class="cart-primary">Start ordering</button></form>'
        + '<button type="button" class="cart-gate-skip" data-cart-act="gate-skip">Just look at the menu</button>';
      body.querySelector("form").addEventListener("submit", gateSubmit);
    }
    body.querySelector("#gate-err").textContent = gateError;
    body.querySelector("#gate-code").setAttribute("aria-invalid", gateError ? "true" : "false");
    const btn = body.querySelector('button[type="submit"]');
    btn.disabled = gateBusy;
    btn.textContent = gateBusy ? "Checking…" : "Start ordering";
  }

  async function gateSubmit(e) {
    e.preventDefault();
    if (gateBusy) return;
    const tableIn = gate.querySelector("#gate-table"), codeIn = gate.querySelector("#gate-code");
    const t = table || cleanTable(tableIn ? tableIn.value : "");
    const code = codeIn.value.replace(/\D/g, "");
    if (!t) {
      gateError = tableIn.value.trim() ? "That doesn’t look like a table number. Use the one on the QR code, like 12 or T12." : "Please enter your table number. It’s on the QR code on your table.";
      paintGate();
      tableIn.focus();
      return;
    }
    if (!/^\d{4}$/.test(code)) {
      gateError = codeIn.value.trim() ? "Today’s code is 4 digits." : "Please enter today’s code. Your server can tell you.";
      paintGate();
      codeIn.focus();
      return;
    }
    gateBusy = true;
    gateError = "";
    paintGate();
    let ok;
    try {
      ok = await (await firebase()).checkCode(C, code);
    } catch (err) {
      console.warn("[cart] Couldn't check the code:", err);
      gateBusy = false;
      gateError = "Couldn’t check the code. Check your internet connection and try again.";
      paintGate();
      return;
    }
    gateBusy = false;
    if (!gate) return;
    if (!ok) {
      gateError = "That code isn’t right. Please ask your server for today’s code.";
      codeIn.value = "";
      paintGate();
      const card = gate.querySelector(".cart-gate-card");
      card.classList.remove("cart-shake");
      void card.offsetWidth;   // restart the shake animation
      card.classList.add("cart-shake");
      codeIn.focus();
      return;
    }
    if (!table) setTable(t);
    rememberCode(code);
    closeGate();
    live.textContent = "You’re all set. Tap + Add on anything you’d like.";
  }

  function closeGate() {
    if (!gate) return;
    gate.remove();
    gate = null;
    doc.classList.remove("cart-lock");
    refresh();
  }

  function skipGate() {
    try { sessionStorage.setItem(GATE_SKIP_KEY, "1"); } catch (_) {}
    closeGate();
    live.textContent = paused ? "Ordering is paused. You can look at the menu." : "You can look at the menu. You’ll need today’s code to order.";
  }

  let fbModule = null;
  function firebase() {
    fbModule = fbModule || import(new URL("orders-firebase.js" + new URL(CART_SRC).search, CART_SRC).href).catch(err => { fbModule = null; throw err; });
    return fbModule;
  }

  function watchTracked() {
    if (!C.firebase) return;
    tracked.forEach(o => {
      if (watching.has(o.id)) return;
      watching.set(o.id, () => {});
      firebase().then(fb => {
        const stop = fb.watchOrder(C, o.id, ({ status, statusAt }) => {
          const entry = tracked.find(t => t.id === o.id);
          if (!entry || !STATUS[status] || entry.status === status) return;
          entry.status = status;
          entry.statusAt = statusAt || Date.now();
          saveTracked();
          live.textContent = `Order ${entry.code}: ${STATUS[status].label}. ${STATUS[status].note}`;
          refresh();
        });
        watching.set(o.id, stop);
      }).catch(err => { watching.delete(o.id); console.warn("[cart] Couldn't load order status:", err); });
    });
  }

  /* ---------- Cart state ---------- */

  let lines = [];   // { key, id, name, variant, unitPrice, qty }
  let notes = "";

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey()) || "null");
      if (saved && Array.isArray(saved.lines)) {
        lines = saved.lines;
        notes = typeof saved.notes === "string" ? saved.notes : "";
      }
    } catch (_) { /* storage blocked or unreadable: start with an empty cart */ }
    lines = lines.filter(l => l && typeof l.id === "string" && Number.isInteger(l.qty) && l.qty > 0 && Number.isFinite(l.unitPrice));
    // When the page can look items up, drop saved lines that left the menu or sold out, and use today's names and prices
    if (typeof C.getItem === "function") {
      lines = lines.filter(l => {
        let item = null;
        try { item = C.getItem(l.id); } catch (_) {}
        if (!item || isSoldOut(l.id, item.name)) return false;
        let price = item.price;
        if (l.variant) {
          const v = (item.variants || []).find(v => v.label === l.variant);
          if (!v) return false;
          price = v.price;
        }
        if (!Number.isFinite(price)) return false;
        Object.assign(l, { key: lineKey(l.id, l.variant), name: item.name, unitPrice: price, qty: Math.min(l.qty, MAX_QTY) });
        return true;
      });
    }
  }

  function save() {
    try { localStorage.setItem(storeKey(), JSON.stringify({ lines, notes })); } catch (_) { /* cart still works for this visit */ }
  }

  // A guest with no table in the link typed one in at checkout: move their cart to that table's saved cart,
  // and put the table in the link so a reload keeps it
  function setTable(t) {
    const fromKey = storeKey();
    table = t;
    try {
      const other = JSON.parse(localStorage.getItem(storeKey()) || "null");
      if (other && Array.isArray(other.lines)) {
        other.lines.forEach(o => {
          if (!o || typeof o.key !== "string" || !Number.isInteger(o.qty) || !Number.isFinite(o.unitPrice)) return;
          const mine = lines.find(l => l.key === o.key);
          if (mine) mine.qty = Math.min(MAX_QTY, mine.qty + o.qty);
          else lines.push(o);
        });
      }
      localStorage.removeItem(fromKey);
    } catch (_) {}
    save();
    try {
      const url = new URL(location.href);
      url.searchParams.set("table", t);
      history.replaceState(history.state, "", url);
    } catch (_) {}
    paintTable();
    loadTracked();   // this table's earlier orders, if any
    watchTracked();
  }

  function paintTable() {
    document.querySelectorAll("[data-cart-table]").forEach(el => {
      el.textContent = table ? "Table " + table : "";
      el.hidden = !table;
    });
  }

  // item is needed only when the line is new: { id, name, variant, price }
  function setQty(key, qty, item) {
    pendingId = null;   // the cart changed, so a retry is a new order
    qty = Math.max(0, Math.min(MAX_QTY, qty));
    const i = lines.findIndex(l => l.key === key);
    if (i === -1) {
      if (qty > 0 && item) lines.push({ key, id: item.id, name: item.name, variant: item.variant || null, unitPrice: item.price, qty });
    } else if (qty === 0) lines.splice(i, 1);
    else lines[i].qty = qty;
    save();
    refresh();
  }

  const qtyOf = key => (lines.find(l => l.key === key) || { qty: 0 }).qty;
  const countForItem = id => lines.reduce((n, l) => n + (l.id === id ? l.qty : 0), 0);

  function totals() {
    const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    const serviceCharge = Math.round(subtotal * servicePct / 100);
    return { count: lines.reduce((n, l) => n + l.qty, 0), subtotal, serviceCharge, total: subtotal + serviceCharge };
  }

  /* ---------- Placing an order ---------- */

  // Add future fields here; nothing else needs to change.
  function buildOrder() {
    const t = totals();
    return {
      restaurant: C.restaurantId,
      table,
      ...(codeRequired() ? { code: dailyCode } : {}),
      items: lines.map(l => ({ id: l.id, name: l.name, variant: l.variant, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.unitPrice * l.qty })),
      notes: notes.trim(),
      subtotal: t.subtotal,
      serviceCharge: t.serviceCharge,
      total: t.total,
      createdAt: new Date().toISOString()
    };
  }

  // The only place an order leaves the page: Firebase if configured, else the webhook, else just logged.
  // Resolves with { id } (the Firebase order id, or null) once the order is accepted;
  // throws on any failure so the cart is kept.
  let pendingId = null;   // reused if the guest retries the same cart, so a slow first attempt can't double the order
  async function submitOrder(order) {
    if (C.firebase) {
      const fb = await firebase();
      pendingId = pendingId || fb.newOrderId(C);
      await fb.saveOrder(C, pendingId, order);
      const id = pendingId;
      pendingId = null;
      return { id };
    }
    if (!C.orderWebhookUrl) {
      console.log("[cart] No orderWebhookUrl set, so the order was only logged:", order);
      await new Promise(r => setTimeout(r, 400));
      return { id: null };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const res = await fetch(C.orderWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(order),
        signal: abort.signal
      });
      if (!res.ok) throw new Error("Order webhook answered HTTP " + res.status);
    } finally {
      clearTimeout(timer);
    }
    return { id: null };
  }

  /* ---------- Controls on menu items ---------- */

  function readItem(el) {
    const d = el.dataset;
    let variants = null;
    if (d.cartVariants) {
      try {
        variants = JSON.parse(d.cartVariants)
          .filter(v => v && v.label != null && v.price !== "" && Number.isFinite(Number(v.price)))
          .map(v => ({ label: String(v.label), price: Number(v.price) }));
      } catch (_) {}
      if (variants && !variants.length) variants = null;
    }
    const price = d.cartPrice ? Number(d.cartPrice) : NaN;
    return { id: d.cartId, name: d.cartName || d.cartId, price, variants };
  }

  const stepperHTML = (key, qty, name) =>
    `<div class="cart-step" role="group" aria-label="${esc(name)}, quantity ${qty}">`
    + `<button type="button" data-cart-act="dec" data-key="${esc(key)}" aria-label="One less ${esc(name)}">−</button>`
    + `<span class="cart-qty" aria-hidden="true">${qty}</span>`
    + `<button type="button" data-cart-act="inc" data-key="${esc(key)}" aria-label="One more ${esc(name)}"${qty >= MAX_QTY ? " disabled" : ""}>+</button></div>`;

  function controlHTML(it) {
    if (paused) return "";
    if (!it.variants && !Number.isFinite(it.price)) return "";
    if (isSoldOut(it.id, it.name)) return '<span class="cart-soldout">Sold out</span>';
    if (it.variants) {
      const n = countForItem(it.id);
      return `<button type="button" class="cart-add" data-cart-act="choose" aria-haspopup="dialog" aria-label="Add ${esc(it.name)}, choose an option${n ? `, ${n} in your order` : ""}">+ Add${n ? `<span class="cart-badge">${n}</span>` : ""}</button>`;
    }
    const q = qtyOf(it.id);
    return q ? stepperHTML(it.id, q, it.name) : `<button type="button" class="cart-add" data-cart-act="add" aria-label="Add ${esc(it.name)} to your order">+ Add</button>`;
  }

  const painted = new WeakMap();
  function paint(el, html) {
    if (painted.get(el) === html) return;
    painted.set(el, html);
    el.innerHTML = html;
  }

  function decorate() {
    const root = document.querySelector(C.menuSelector || "body");
    if (!root) return;
    root.querySelectorAll("[data-cart-id]").forEach(el => {
      const html = controlHTML(readItem(el));
      let ctl = el.querySelector(":scope > .cart-ctl");
      if (!ctl) {
        if (!html) return;
        ctl = document.createElement("div");
        ctl.className = "cart-ctl";
        el.appendChild(ctl);
      }
      paint(ctl, html);
    });
  }

  /* ---------- Floating bar and order sheet ---------- */

  let bar, barBtn, sheet, panel, titleEl, bodyEl, footEl, linesEl, sumEl, notesEl, live;
  let view = "review";   // "review" | "choose" | "sent" | "status"
  let sentId = null;
  let chooseItem = null, sending = false, error = "", opener = null;
  let asking = false, tableError = "", codeError = "";
  let whereEl, askEl, askTableEl, askInput, askErrEl, askCodeEl, codeInput, codeErrEl, pausedEl;

  function build() {
    live = document.createElement("div");
    live.className = "cart-sr";
    live.setAttribute("aria-live", "polite");

    bar = document.createElement("div");
    bar.className = "cart-bar";
    bar.hidden = true;
    bar.innerHTML = '<button type="button" class="cart-bar-btn" data-cart-act="open" aria-haspopup="dialog"></button>';
    barBtn = bar.firstChild;

    sheet = document.createElement("div");
    sheet.className = "cart-sheet";
    sheet.hidden = true;
    sheet.innerHTML =
      '<div class="cart-scrim" data-cart-act="close"></div>'
      + '<div class="cart-panel" role="dialog" aria-modal="true" aria-labelledby="cart-title">'
      + '<div class="cart-head"><h2 id="cart-title" tabindex="-1"></h2><button type="button" class="cart-x" data-cart-act="close" aria-label="Close">×</button></div>'
      + '<div class="cart-body"></div><div class="cart-foot"></div></div>';
    panel = sheet.querySelector(".cart-panel");
    titleEl = sheet.querySelector("h2");
    bodyEl = sheet.querySelector(".cart-body");
    footEl = sheet.querySelector(".cart-foot");

    document.body.append(live, bar, sheet);
  }

  function paintBar() {
    const t = totals(), active = activeOrders();
    if (paused && t.count === 0 && !active.length) {
      // Nothing to show but the pause: say so, so guests know to ask their server
      doc.classList.add("cart-has-bar");
      bar.hidden = !sheet.hidden;
      barBtn.dataset.cartAct = "none";
      paint(barBtn, '<span class="cart-bar-count">Ordering is paused</span><span class="cart-bar-cta cart-bar-note">Please order with your server</span>');
      return;
    }
    const show = t.count > 0 || active.length > 0;
    doc.classList.toggle("cart-has-bar", show);
    bar.hidden = !show || !sheet.hidden;
    if (t.count > 0 || !active.length) {
      barBtn.dataset.cartAct = "open";
      paint(barBtn, `<span class="cart-bar-count">${t.count} ${t.count === 1 ? "item" : "items"}</span><span class="cart-bar-dot" aria-hidden="true">·</span>`
        + `<span class="cart-bar-total">${money(t.subtotal)}</span><span class="cart-bar-cta">View order</span>`);
    } else {
      // Nothing in the cart but an order in progress: the bar tracks it
      const o = active[0];
      barBtn.dataset.cartAct = "status";
      paint(barBtn, `<span class="cart-bar-count">Order #${esc(o.code)}</span><span class="cart-bar-dot" aria-hidden="true">·</span>`
        + `<span class="cart-bar-status" data-status="${esc(o.status)}">${esc(STATUS[o.status].label)}</span><span class="cart-bar-cta">Track</span>`);
    }
  }

  function trackerHTML(o) {
    const step = STEPS.indexOf(o.status);
    let html = `<div class="cart-track" data-status="${esc(o.status)}"><div class="cart-track-head"><span class="cart-code">Order #${esc(o.code)}</span>`
      + (o.table ? `<span class="cart-table-pill">Table ${esc(o.table)}</span>` : "") + "</div>";
    if (o.status === "cancelled") html += '<p class="cart-track-cancel">Cancelled</p>';
    else html += '<ol class="cart-steps">' + STEPS.map((s, i) =>
      `<li class="${i < step ? "done" : i === step ? "now" : ""}"${i === step ? ' aria-current="step"' : ""}><span class="cart-dot" aria-hidden="true"></span>${esc(STATUS[s].label)}</li>`).join("") + "</ol>";
    return html + `<p class="cart-track-note">${esc(STATUS[o.status].note)}</p></div>`;
  }

  function lineHTML(l) {
    return `<div class="cart-line"><div class="cart-line-name">${esc(l.name)}${l.variant ? `<span class="cart-line-variant">${esc(l.variant)}</span>` : ""}</div>`
      + `<div class="cart-line-total">${money(l.unitPrice * l.qty)}</div>`
      + `<div class="cart-line-actions">${stepperHTML(l.key, l.qty, l.variant ? `${l.name} (${l.variant})` : l.name)}`
      + `<span class="cart-line-each">${money(l.unitPrice)} each</span>`
      + `<button type="button" class="cart-remove" data-cart-act="remove" data-key="${esc(l.key)}" aria-label="Remove ${esc(l.name)}${l.variant ? ` (${esc(l.variant)})` : ""}">Remove</button></div></div>`;
  }

  function paintSheet() {
    if (sheet.hidden) return;
    if (view === "choose") {
      const it = chooseItem;
      titleEl.textContent = it.name;
      paint(bodyEl, '<p class="cart-hint">Choose an option. Each one is a separate line in your order.</p>'
        + it.variants.map((v, i) => {
          const key = lineKey(it.id, v.label), q = qtyOf(key);
          return `<div class="cart-option"><span class="cart-option-name">${esc(v.label)}</span><span class="cart-option-price">${money(v.price)}</span>`
            + (q ? stepperHTML(key, q, `${it.name} (${v.label})`) : `<button type="button" class="cart-add" data-cart-act="vadd" data-idx="${i}" aria-label="Add ${esc(it.name)}, ${esc(v.label)}">+ Add</button>`)
            + "</div>";
        }).join(""));
      paint(footEl, '<button type="button" class="cart-primary" data-cart-act="close">Done</button>');
      return;
    }
    if (view === "sent") {
      titleEl.textContent = "Order sent!";
      const o = sentId && tracked.find(t => t.id === sentId);
      paint(bodyEl, o
        ? '<div class="cart-sent cart-sent-live"><div class="cart-sent-mark" aria-hidden="true">✓</div><p>Your order is with the restaurant. This updates as they get to it.</p></div>' + trackerHTML(o)
        : '<div class="cart-sent"><div class="cart-sent-mark" aria-hidden="true">✓</div>'
          + (table ? `<p class="cart-table-pill">Table ${esc(table)}</p>` : "") + "<p>Your server will confirm shortly.</p></div>");
      paint(footEl, '<button type="button" class="cart-primary" data-cart-act="close">Back to the menu</button>');
      return;
    }
    if (view === "status") {
      const active = activeOrders();
      titleEl.textContent = active.length > 1 ? "Your orders" : "Your order";
      paint(bodyEl, active.length ? active.map(trackerHTML).join("") : '<p class="cart-empty">No orders in progress.</p>');
      paint(footEl, '<button type="button" class="cart-primary" data-cart-act="close">Back to the menu</button>');
      return;
    }
    titleEl.textContent = "Your order";
    if (!bodyEl.querySelector(".cart-lines")) {
      // Built once per opening so typing in the notes box is never interrupted by a repaint
      painted.delete(bodyEl);
      bodyEl.innerHTML = '<div class="cart-where"></div><div class="cart-lines"></div>'
        + '<div class="cart-notes"><label for="cart-notes">Notes for the kitchen <span>(optional)</span></label>'
        + '<textarea id="cart-notes" rows="2" maxlength="300" placeholder="For example: less spicy, no onion"></textarea></div>'
        + '<div class="cart-sum"></div>'
        + '<p class="cart-paused-note" hidden>Ordering is paused right now. Please order with your server.</p>'
        + '<div class="cart-ask" hidden>'
        + '<div class="cart-ask-field" data-field="table"><label for="cart-table">Your table number</label>'
        + '<input id="cart-table" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="10" placeholder="For example: 12" aria-describedby="cart-table-hint cart-table-err">'
        + '<p id="cart-table-hint" class="cart-ask-hint">You’ll find it on the QR code on your table.</p>'
        + '<p id="cart-table-err" class="cart-ask-err" role="alert"></p></div>'
        + '<div class="cart-ask-field" data-field="code"><label for="cart-code">Today’s code</label>'
        + '<input id="cart-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="4" placeholder="4 digits" aria-describedby="cart-code-hint cart-code-err">'
        + '<p id="cart-code-hint" class="cart-ask-hint">Ask your server for today’s code, or check the card at your table. You only need it once per visit.</p>'
        + '<p id="cart-code-err" class="cart-ask-err" role="alert"></p></div></div>';
      whereEl = bodyEl.querySelector(".cart-where");
      pausedEl = bodyEl.querySelector(".cart-paused-note");
      askEl = bodyEl.querySelector(".cart-ask");
      askTableEl = askEl.querySelector('[data-field="table"]');
      askInput = askTableEl.querySelector("input");
      askErrEl = askTableEl.querySelector(".cart-ask-err");
      askCodeEl = askEl.querySelector('[data-field="code"]');
      codeInput = askCodeEl.querySelector("input");
      codeErrEl = askCodeEl.querySelector(".cart-ask-err");
      [askInput, codeInput].forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); place(); } }));
      linesEl = bodyEl.querySelector(".cart-lines");
      sumEl = bodyEl.querySelector(".cart-sum");
      notesEl = bodyEl.querySelector("textarea");
      notesEl.value = notes;
      notesEl.addEventListener("input", () => { notes = notesEl.value; pendingId = null; save(); });
    }
    const t = totals();
    const active = activeOrders();
    paint(whereEl, (table ? `<p class="cart-table-pill">Table ${esc(table)}</p>` : "")
      + (active.length ? `<button type="button" class="cart-track-link" data-cart-act="status">Earlier order #${esc(active[0].code)}: ${esc(STATUS[active[0].status].label)}. Track it</button>` : ""));
    const needTable = !table, needCode = codeRequired() && !dailyCode;
    askEl.hidden = !(asking && (needTable || needCode) && lines.length && !paused);
    askTableEl.hidden = !needTable;
    askCodeEl.hidden = !needCode;
    askErrEl.textContent = tableError;
    codeErrEl.textContent = codeError;
    askInput.setAttribute("aria-invalid", tableError ? "true" : "false");
    codeInput.setAttribute("aria-invalid", codeError ? "true" : "false");
    pausedEl.hidden = !paused || !lines.length;
    bodyEl.querySelector(".cart-notes").hidden = !lines.length;
    paint(linesEl, lines.length ? lines.map(lineHTML).join("") : '<p class="cart-empty">Your order is empty. Tap “+ Add” on anything you’d like.</p>');
    paint(sumEl, lines.length
      ? `<span>Subtotal</span><span>${money(t.subtotal)}</span>`
        + `<span>Service charge (${servicePct}%)</span><span>${money(t.serviceCharge)}</span>`
        + `<span class="cart-grand">Estimated total</span><span class="cart-grand">${money(t.total)}</span>`
        + '<p class="cart-fine">Taxes apply. Your final bill comes from the restaurant.</p>'
      : "");
    paint(footEl, (error ? `<p class="cart-error" role="alert">${esc(error)}</p>` : "")
      + `<button type="button" class="cart-primary" data-cart-act="place"${!lines.length || sending || paused ? " disabled" : ""}>${sending ? "Sending…" : paused ? "Ordering is paused" : lines.length ? `Place order · ${money(t.total)}` : "Place order"}</button>`);
  }

  function openSheet(nextView, from) {
    view = nextView;
    opener = from || document.activeElement;
    error = view === "review" ? error : "";
    painted.delete(bodyEl);
    bodyEl.innerHTML = "";
    sheet.hidden = false;
    doc.classList.add("cart-lock");
    refresh();
    titleEl.focus();
  }

  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    doc.classList.remove("cart-lock");
    if (view === "sent") view = "review";
    refresh();
    // Return focus to what opened the sheet, or to the bar if that control has been re-rendered away
    const back = opener && opener.isConnected ? opener : (!bar.hidden ? barBtn : null);
    if (back) back.focus();
  }

  function focusAsk() {
    refresh();
    askEl.scrollIntoView({ block: "nearest" });
    const first = [[askTableEl, askInput], [askCodeEl, codeInput]].find(([el, input]) => !el.hidden && (!input.value.trim() || input.getAttribute("aria-invalid") === "true"))
      || [[askTableEl, askInput], [askCodeEl, codeInput]].find(([el]) => !el.hidden);
    if (first) first[1].focus();
  }

  async function place() {
    if (sending || !lines.length || paused) return;
    const needTable = !table, needCode = codeRequired() && !dailyCode;
    if (needTable || needCode) {
      // Missing the table (no table in the link) or today's code: ask here rather than blocking browsing
      if (!asking) {
        asking = true;
        tableError = codeError = "";
        focusAsk();
        return;
      }
      const t = needTable ? cleanTable(askInput.value) : table;
      const code = needCode ? codeInput.value.replace(/\D/g, "") : dailyCode;
      tableError = needTable && !t
        ? (askInput.value.trim() ? "That doesn’t look like a table number. Use the one on the QR code, like 12 or T12." : "Please enter your table number to place the order.")
        : "";
      codeError = needCode && !/^\d{4}$/.test(code)
        ? (codeInput.value.trim() ? "Today’s code is 4 digits." : "Please enter today’s code. Your server can tell you.")
        : "";
      if (tableError || codeError) { focusAsk(); return; }
      asking = false;
      if (needTable) setTable(t);
      if (needCode) rememberCode(code);
    }
    sending = true;
    error = "";
    refresh();
    try {
      const order = buildOrder();
      const { id } = await submitOrder(order);
      sentId = id;
      if (id) {
        tracked.unshift({ id, code: id.slice(0, 4).toUpperCase(), table: order.table, at: Date.now(), status: "new", statusAt: Date.now() });
        tracked = tracked.slice(0, 10);
        saveTracked();
        watchTracked();
      }
      lines = [];
      notes = "";
      save();
      view = "sent";
      painted.delete(bodyEl);
      bodyEl.innerHTML = "";
    } catch (err) {
      console.error("[cart] Order was not sent:", err);
      if (err && err.code === "permission-denied" && codeRequired() && !paused) {
        // Firebase refused it: the code is wrong or has changed since this phone saved it
        rememberCode(null);
        codeInput.value = "";
        codeError = "That code didn’t work. It may have changed. Please check today’s code with your server.";
        asking = true;
        error = "";
        sending = false;
        focusAsk();
        return;
      }
      error = paused
        ? "Ordering was paused just now. Please order with your server. Your order is still here."
        : "We couldn't send your order. Check your connection and try again, or ask your server. Your order is still here.";
    }
    sending = false;
    refresh();
    if (view === "sent") titleEl.focus();
  }

  function refresh() {
    decorate();
    paintBar();
    paintSheet();
  }

  /* ---------- Events ---------- */

  // After a repaint, put focus back on the equivalent control so keyboard and screen reader users don't lose their place
  function refocus(scope, key, act) {
    const pick = sel => scope && scope.querySelector(sel);
    const el = (key && (pick(`[data-cart-act="${act}"][data-key="${CSS.escape(key)}"]`) || pick(`[data-key="${CSS.escape(key)}"]`)))
      || pick('[data-cart-act="inc"]') || pick('[data-cart-act="add"], [data-cart-act="choose"]');
    if (el) el.focus();
    else if (!sheet.hidden) titleEl.focus();
  }

  function onClick(e) {
    const b = e.target.closest("[data-cart-act]");
    if (!b) return;
    const act = b.dataset.cartAct, key = b.dataset.key;
    const itemEl = b.closest("[data-cart-id]");

    if (act === "add" && itemEl) {
      const it = readItem(itemEl);
      setQty(it.id, qtyOf(it.id) + 1, { id: it.id, name: it.name, price: it.price });
      live.textContent = `Added ${it.name}. ${totals().count} in your order.`;
      refocus(itemEl.querySelector(":scope > .cart-ctl"), it.id, "inc");
    } else if (act === "choose" && itemEl) {
      chooseItem = readItem(itemEl);
      openSheet("choose", b);
    } else if (act === "vadd" && chooseItem) {
      const v = chooseItem.variants[Number(b.dataset.idx)];
      if (!v) return;
      const k = lineKey(chooseItem.id, v.label);
      setQty(k, qtyOf(k) + 1, { id: chooseItem.id, name: chooseItem.name, variant: v.label, price: v.price });
      live.textContent = `Added ${chooseItem.name}, ${v.label}.`;
      refocus(bodyEl, k, "inc");
    } else if (act === "inc" || act === "dec") {
      const next = qtyOf(key) + (act === "inc" ? 1 : -1);
      setQty(key, next);
      if (next === 0) live.textContent = "Removed from your order.";
      refocus(itemEl ? itemEl.querySelector(":scope > .cart-ctl") : bodyEl, next ? key : null, act);
    } else if (act === "remove") {
      setQty(key, 0);
      live.textContent = "Removed from your order.";
      refocus(bodyEl, null, "remove");
    } else if (act === "open") {
      openSheet("review", b);
    } else if (act === "status") {
      if (!sheet.hidden) { view = "status"; painted.delete(bodyEl); bodyEl.innerHTML = ""; refresh(); titleEl.focus(); }
      else openSheet("status", b);
    } else if (act === "close") {
      closeSheet();
    } else if (act === "place") {
      place();
    } else if (act === "gate-skip") {
      skipGate();
    }
  }

  function onKey(e) {
    if (gate) {
      // The welcome screen: Escape means "just look at the menu"; Tab stays inside it
      if (e.key === "Escape") { e.preventDefault(); skipGate(); return; }
      if (e.key !== "Tab") return;
      const f = [...gate.querySelectorAll("button:not([disabled]), input")];
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (sheet.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key !== "Tab") return;
    // Keep Tab inside the open sheet
    const f = [...panel.querySelectorAll('button:not([disabled]), textarea, input, [tabindex="-1"]')].filter(el => el.offsetParent !== null || el === titleEl);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function init() {
    load();
    loadTracked();
    build();
    paintTable();
    watchTracked();
    watchPause();
    doc.classList.add("cart-on");
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    // The menu rebuilds its items on every tab change, search and filter; re-add the controls each time.
    // Runs before the browser paints, so items never flash without their buttons.
    const root = document.querySelector(C.menuSelector || "body");
    if (root) new MutationObserver(decorate).observe(root, { childList: true, subtree: true });
    refresh();
    if (gateWanted()) openGate();
  }

  window.MenuCart = { buildOrder, submitOrder };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
