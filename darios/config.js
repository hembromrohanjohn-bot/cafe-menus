// Dario's settings, shared by the menu (index.html) and the staff order screen (staff.html).
// Everything restaurant-specific for the cart lives here.
window.MENU_CONFIG = {
  restaurantId: "darios",
  restaurantName: "Dario's",
  currency: "₹",
  locale: "en-IN",
  serviceChargePercent: 7,
  orderingEnabled: true,        // false = view-only menu, exactly as before
  orderWebhookUrl: "",          // only used when firebase (below) isn't set
  soldOut: [],                  // dish names that can't be ordered today, e.g. ["Tiramisu"]
  menuSelector: "#pages",       // where the menu items are rendered
  getItem: id => cartItem(id),  // lets the cart re-check a saved order against today's menu

  // Orders are saved here, and the staff screen reads them. These values are meant to be public;
  // the Firestore security rules decide who can read and change orders.
  firebase: {
    apiKey: "AIzaSyAtfpZcTSN5IUyftksPNutwjW_fRZhYYbc",
    authDomain: "darios-order.firebaseapp.com",
    projectId: "darios-order",
    storageBucket: "darios-order.firebasestorage.app",
    messagingSenderId: "839534144228",
    appId: "1:839534144228:web:b9092a76ee62e759ef5af1"
  }
};
