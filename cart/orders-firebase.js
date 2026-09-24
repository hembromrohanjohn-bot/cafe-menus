// Firebase side of the cart: saves orders and watches their status. Loaded by cart.js only when
// MENU_CONFIG.firebase is set. Orders live at restaurants/{restaurantId}/orders/{orderId}.
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

// Calls back with { status, statusAt } every time staff update the order; returns a function that stops watching
export function watchOrder(config, id, callback) {
  return onSnapshot(doc(ordersOf(config), id), snap => {
    if (snap.exists()) callback({ status: snap.get("status"), statusAt: snap.get("statusAt")?.toMillis?.() || null });
  }, err => console.warn("[cart] Couldn't follow order status:", err));
}
