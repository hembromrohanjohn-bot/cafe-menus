// Staff order screen: live list of today's orders, with a chime for new ones and buttons to move them along.
// Shared by every restaurant; reads window.MENU_CONFIG (restaurantId, restaurantName, currency, locale, firebase).
const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const { initializeApp } = await import(SDK + "firebase-app.js");
const { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } = await import(SDK + "firebase-auth.js");
const { getFirestore, collection, query, where, orderBy, limit, onSnapshot, doc, updateDoc, serverTimestamp, Timestamp } = await import(SDK + "firebase-firestore.js");

const C = window.MENU_CONFIG;
const app = initializeApp(C.firebase);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => (C.currency || "₹") + Math.round(Number(n) || 0).toLocaleString(C.locale || "en-IN");
const clock = d => d.toLocaleTimeString(C.locale || "en-IN", { hour: "numeric", minute: "2-digit" });

// Staff sign in with a username. Firebase logins need an email address, so a username like "darios"
// becomes "darios@darios.staff.invalid" behind the scenes (.invalid can never be a real inbox).
const LOGIN_DOMAIN = `@${C.restaurantId}.staff.invalid`;
const toLogin = name => (name.includes("@") ? name : name + LOGIN_DOMAIN).trim().toLowerCase();
const username = user => (user?.email || "").replace(LOGIN_DOMAIN, "");

// What each status is called, and the button that moves an order on from it
const FLOW = {
  new:       { label: "New",        next: "accepted",  button: "Accept" },
  accepted:  { label: "Accepted",   next: "preparing", button: "Start preparing" },
  preparing: { label: "Preparing",  next: "served",    button: "Mark served" },
  served:    { label: "Served" },
  cancelled: { label: "Cancelled" }
};
const WINDOW_HOURS = 16;   // show orders from the last 16 hours, so a late shift doesn't lose orders at midnight

let orders = [];           // newest first
let stopListening = null;
let firstSnapshot = true;
let confirmCancel = null;  // order id waiting for a second tap on Cancel
let busy = new Set();      // order ids with an update on its way

document.title = `Orders · ${C.restaurantName}`;
const brandName = $("#brand-name"); if (brandName) brandName.textContent = C.restaurantName;

/* ---------- Sign in ---------- */

onAuthStateChanged(auth, user => {
  $("#booting").hidden = true;
  $("#login-form").hidden = !!user;
  $("#board").hidden = !user;
  $("#who").textContent = user ? "Signed in as " + username(user) : "";
  $("#signout").hidden = !user;
  if (stopListening) { stopListening(); stopListening = null; }
  if (user) listen();
  else { orders = []; render(); }
});

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#login-btn"), err = $("#login-err");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  err.textContent = "";
  unlockSound();   // the tap on Sign in lets the browser play the chime later
  try {
    await signInWithEmailAndPassword(auth, toLogin($("#username").value), $("#password").value);
    $("#password").value = "";
  } catch (x) {
    err.textContent = {
      "auth/invalid-credential": "Wrong username or password.",
      "auth/invalid-email": "Usernames can only use letters, numbers, dots, dashes and underscores.",
      "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
      "auth/network-request-failed": "No internet connection."
    }[x.code] || "Couldn't sign in: " + (x.code || x.message);
  }
  btn.disabled = false;
  btn.textContent = "Sign in";
});
$("#signout").addEventListener("click", () => signOut(auth));

/* ---------- Live orders ---------- */

function listen() {
  firstSnapshot = true;
  $("#problem").hidden = true;
  const since = Timestamp.fromMillis(Date.now() - WINDOW_HOURS * 3600e3);
  const q = query(collection(db, "restaurants", C.restaurantId, "orders"), where("placedAt", ">=", since), orderBy("placedAt", "desc"), limit(300));
  stopListening = onSnapshot(q, snap => {
    const before = new Set(orders.map(o => o.id));
    orders = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    const fresh = orders.filter(o => o.status === "new" && !before.has(o.id));
    if (fresh.length && !firstSnapshot) { chime(); flash(fresh.map(o => o.id)); }
    if (firstSnapshot && orders.some(o => o.status === "new")) chime();
    firstSnapshot = false;
    render();
  }, err => {
    console.error("[staff] Order list stopped:", err);
    $("#problem").hidden = false;
    $("#problem").textContent = err.code === "permission-denied"
      ? `The account "${username(auth.currentUser)}" isn't allowed to see ${C.restaurantName}'s orders. Sign out and use the staff account.`
      : "Lost the connection to the order list. Reload the page.";
  });
}

async function setStatus(id, status) {
  if (busy.has(id)) return;
  busy.add(id);
  render();
  try {
    await updateDoc(doc(db, "restaurants", C.restaurantId, "orders", id), { status, statusAt: serverTimestamp(), statusBy: auth.currentUser.email });
  } catch (err) {
    console.error("[staff] Couldn't update order:", err);
    alertBar(err.code === "permission-denied" ? "This account can't change orders." : "Couldn't update the order. Check the internet connection and try again.");
  }
  busy.delete(id);
  render();
}

$("#board").addEventListener("click", e => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === "next") { confirmCancel = null; setStatus(id, b.dataset.next); }
  if (b.dataset.act === "cancel") {
    if (confirmCancel === id) { confirmCancel = null; setStatus(id, "cancelled"); }
    else {
      confirmCancel = id;
      render();
      setTimeout(() => { if (confirmCancel === id) { confirmCancel = null; render(); } }, 4000);
    }
  }
});

/* ---------- Drawing ---------- */

const ago = ms => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

function cardHTML(o) {
  const placed = o.placedAt?.toMillis ? o.placedAt.toMillis() : Date.now();
  const f = FLOW[o.status] || FLOW.new;
  const waiting = o.status === "new" && Date.now() - placed > 5 * 60e3;
  let actions = "";
  if (f.next) actions += `<button class="go" data-act="next" data-id="${esc(o.id)}" data-next="${f.next}"${busy.has(o.id) ? " disabled" : ""}>${busy.has(o.id) ? "Saving…" : f.button}</button>`;
  if (o.status === "new" || o.status === "accepted")
    actions += `<button class="cancel${confirmCancel === o.id ? " confirm" : ""}" data-act="cancel" data-id="${esc(o.id)}"${busy.has(o.id) ? " disabled" : ""}>${confirmCancel === o.id ? "Tap again to cancel" : "Cancel"}</button>`;
  return `<article class="order" data-status="${esc(o.status)}" data-id="${esc(o.id)}">`
    + `<header><div class="table"><small>Table</small><b>${esc(o.table || "?")}</b></div><div class="meta"><span class="code">#${esc(o.id.slice(0, 4).toUpperCase())}</span>`
    + `<span class="time${waiting ? " late" : ""}" title="${esc(new Date(placed).toLocaleString())}">${clock(new Date(placed))} · ${ago(placed)}</span></div></header>`
    + `<ul class="items">${(o.items || []).map(i => `<li><span class="qty">${esc(i.qty)}×</span><span>${esc(i.name)}${i.variant ? `<em>${esc(i.variant)}</em>` : ""}</span></li>`).join("")}</ul>`
    + (o.notes ? `<p class="notes"><b>Note</b>${esc(o.notes)}</p>` : "")
    + `<footer><span class="total">${money(o.total)}</span><span class="state">${esc(f.label)}</span></footer>`
    + (actions ? `<div class="actions">${actions}</div>` : "")
    + "</article>";
}

function render() {
  const groups = {
    new: orders.filter(o => o.status === "new").reverse(),   // oldest first: serve in order
    doing: orders.filter(o => o.status === "accepted" || o.status === "preparing").reverse(),
    done: orders.filter(o => o.status === "served" || o.status === "cancelled").slice(0, 30)
  };
  for (const [k, list] of Object.entries(groups)) {
    $(`#count-${k}`).textContent = list.length;
    $(`#list-${k}`).innerHTML = list.length ? list.map(cardHTML).join("") : `<p class="none">${k === "new" ? "All caught up. New orders appear here with a chime." : k === "doing" ? "Nothing in the kitchen right now." : "Served orders from today show here."}</p>`;
  }
  const n = groups.new.length;
  document.title = (n ? `(${n}) New · ` : "") + `Orders · ${C.restaurantName}`;
  document.body.classList.toggle("has-new", n > 0);
}
setInterval(render, 30000);   // keep "5 min ago" current

const tick = () => { $("#clock").textContent = clock(new Date()); };
tick();
setInterval(tick, 15000);

function flash(ids) {
  requestAnimationFrame(() => ids.forEach(id => document.querySelector(`.order[data-id="${CSS.escape(id)}"]`)?.classList.add("arrived")));
}

let alertTimer = null;
function alertBar(msg) {
  const el = $("#problem");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/* ---------- Sound ---------- */

let audio = null;
let soundOn = true;
try { soundOn = localStorage.getItem("staff-sound") !== "off"; } catch (_) {}

function unlockSound() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch (_) {}
  paintSound();
}
// Two-note chime, loud enough for a busy counter
function chime() {
  if (!soundOn || !audio || audio.state !== "running") return;
  const t = audio.currentTime;
  [[880, 0], [1320, 0.18], [880, 0.5], [1320, 0.68]].forEach(([hz, at]) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine";
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.6, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.35);
    o.connect(g).connect(audio.destination);
    o.start(t + at);
    o.stop(t + at + 0.4);
  });
}
// Keep ringing every 20 seconds while an order is waiting to be accepted
setInterval(() => { if (orders.some(o => o.status === "new")) chime(); }, 20000);

function paintSound() {
  const ready = audio && audio.state === "running";
  $("#sound").textContent = soundOn ? "Sound on" : "Sound off";
  $("#sound").setAttribute("aria-pressed", String(soundOn));
  $("#unlock").hidden = !soundOn || ready || !auth.currentUser;
}
$("#sound").addEventListener("click", () => {
  soundOn = !soundOn;
  try { localStorage.setItem("staff-sound", soundOn ? "on" : "off"); } catch (_) {}
  unlockSound();
  if (soundOn) chime();
});
// Browsers only allow sound after a tap, so the first tap anywhere turns it on
document.addEventListener("pointerdown", () => { if (!audio || audio.state !== "running") unlockSound(); });
onAuthStateChanged(auth, () => paintSound());

/* ---------- Keep the tablet awake and show connection ---------- */

let wakeLock = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
}
document.addEventListener("visibilitychange", keepAwake);
keepAwake();

const paintOnline = () => { $("#offline").hidden = navigator.onLine; };
addEventListener("online", paintOnline);
addEventListener("offline", paintOnline);
paintOnline();
