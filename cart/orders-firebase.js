// Firebase side of the cart: saves orders and watches their status. Loaded by cart.js only when
// MENU_CONFIG.firebase is set. Orders live at restaurants/{restaurantId}/orders/{orderId};
// the pause switch at restaurants/{restaurantId}/public/status. Today's code is staff-only and checked by the rules.
const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const { initializeApp, getApps } = await import(SDK + "firebase-app.js");
const { getFirestore, doc, collection, setDoc, getDocFromServer, onSnapshot, serverTimestamp } = await import(SDK + "firebase-firestore.js");

let db = null;
function database(config) {
  if (!db) db = getFirestore(getApps()[0] || initializeApp(config.firebase));
  return db;
}

const ordersOf = config => collection(database(config), "restaurants", config.restaurantId, "orders");

// A fresh random id for an order. The cart keeps it until the order is confirmed saved,
// so a retry after a timeout can never create a second copy of the same order.
export function newOrderId(config) {
  return doc(ordersOf(config)).id;
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms))]);

export async function saveOrder(config, id, order) {
  const ref = doc(ordersOf(config), id);
  try {
    await withTimeout(setDoc(ref, { ...order, notes: order.notes || "", status: "new", placedAt: serverTimestamp() }), 12000);
  } catch (err) {
    // A slow write may still have reached the restaurant, or this may be a retry of one that did:
    // if the order is there, it was placed.
    try {
      if ((await withTimeout(getDocFromServer(ref), 8000)).exists()) return;
    } catch (_) {}
    throw err;
  }
}

// Is this today's code? The rules allow reading restaurants/{id}/codecheck/{code} only for the right code.
// Resolves true or false; throws only if the check couldn't be made (e.g. no internet).
export async function checkCode(config, code) {
  try {
    await withTimeout(getDocFromServer(doc(database(config), "restaurants", config.restaurantId, "codecheck", code)), 10000);
    return true;
  } catch (err) {
    if (err && err.code === "permission-denied") return false;
    throw err;
  }
}

// Calls back with { paused } whenever staff pause or resume ordering; returns a function that stops watching
export function watchOrdering(config, callback) {
  return onSnapshot(doc(database(config), "restaurants", config.restaurantId, "public", "status"),
    snap => callback({ paused: snap.exists() && snap.get("orderingPaused") === true }),
    err => console.warn("[cart] Couldn't follow ordering status:", err));
}

// Calls back with { status, statusAt } every time staff update the order; returns a function that stops watching
export function watchOrder(config, id, callback) {
  return onSnapshot(doc(ordersOf(config), id), snap => {
    if (snap.exists()) callback({ status: snap.get("status"), statusAt: snap.get("statusAt")?.toMillis?.() || null });
  }, err => console.warn("[cart] Couldn't follow order status:", err));
}
