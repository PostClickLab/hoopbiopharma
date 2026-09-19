// Shared shipping method table for the customer checkout page
// (src/main.js) and the checkout API (api/create-checkout-session.js).
export const SHIP_METHODS = {
  priority: { price: 14, label: "Priority Shipping", sub: "2–3 business days" },
  overnight: { price: 50, label: "Overnight Shipping", sub: "Next business day" },
};
