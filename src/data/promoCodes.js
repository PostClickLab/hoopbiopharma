// Single source of truth for promo codes, shared by the client-side cart
// summary (src/main.js) and the checkout API (api/create-checkout-session.js)
// so a discount can never be forged from the browser — the server re-checks
// the code against this same table before creating the Stripe session.
//
// To turn a code off without deleting it: set its value to null,
// e.g.  GOLD: null,
export const PROMO_CODES = {
  GOLD: 0.15,
  PLATINUM: 0.20,
  RUBY: 0.50,
  SAPPHIRE: 0.30,
  SILVER: 0.10,
};
