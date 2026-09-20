import "./style.css";
import { CATEGORIES, PRODUCTS, byId, catInfo, catCount, fmt, familyById, SHOP_ITEMS, displayItem } from "./data/products.js";
import { supabase } from "./supabaseClient.js";

// Remembers which dosage was last selected on each product family's page
// (fam-id -> variant SKU id), so switching dosage doesn't reset on revisit.
let familySelection = {};

/* =========================================================
   CUSTOMER-TYPE PRICING
   Set once the entry gate is answered (Doctor / Retail Customer /
   Wholesaler). Doctors and wholesalers see discounted per-unit
   pricing and a minimum order quantity; retail customers see the
   standard listed price with no minimum.
   ========================================================= */
const CUSTOMER_TIERS = {
  "Retail Customer": { multiplier: 1, moq: 1, key: "retail", badge: null },
  "Doctor": { multiplier: 0.85, moq: 5, key: "doctor", badge: "Doctor pricing" },
  "Wholesaler": { multiplier: 0.65, moq: 25, key: "wholesale", badge: "Wholesale pricing" }
};
let customerType = "Retail Customer";
// The signed-in Supabase user (auth.users row), or null when signed out.
// Set at boot from any existing session and kept in sync by the
// onAuthStateChange listener below.
let currentUser = null;
function currentTier() {
  return CUSTOMER_TIERS[customerType] || CUSTOMER_TIERS["Retail Customer"];
}

// A single hardcoded admin account gates the /admin order-entry portal.
// The real access control lives in Supabase Row Level Security on the
// `orders` table (that table + its RLS policy are created once via a SQL
// script run in the Supabase dashboard, not from this file) — this check
// just decides what the UI shows, so it's fine that it's a plain email match.
const ADMIN_EMAIL = "admin@hoopbiopharma.com";
function isAdmin() {
  return !!(currentUser && currentUser.email && currentUser.email.toLowerCase() === ADMIN_EMAIL);
}

/* =========================================================
   PROMO CODES — no database involved. This list IS the source
   of truth for every promo code on the site.
   To add a code: add a new line, e.g.  WELCOME10: 0.10,  (10% off)
   To change a discount: change the number (0.20 = 20% off, etc).
   To turn a code off without deleting it: set its value to null,
   e.g.  GOLD: null,
   Changes here take effect after you redeploy the site — there is
   nothing to configure anywhere else (no Supabase, no admin form).
   ========================================================= */
import { PROMO_CODES } from "./data/promoCodes.js";
import { SHIP_METHODS } from "./data/shipping.js";
// Rounds to the nearest cent so explicit price-sheet values (which carry
// cents, e.g. $19.875) and multiplier fallback math both come out clean.
function money(n) {
  return Math.round(n * 100) / 100;
}
// Accepts either a product/item object (preferred — checks its explicit
// per-tier pricing from the manufacturing price sheet first) or a raw
// number (legacy call sites / family "from" prices with no tier data).
function tierPrice(itemOrBase) {
  if (itemOrBase && typeof itemOrBase === "object") {
    const tp = itemOrBase.tierPricing;
    if (tp) {
      const v = tp[currentTier().key];
      if (typeof v === "number") return v;
    }
    return money(itemOrBase.price * currentTier().multiplier);
  }
  return money(itemOrBase * currentTier().multiplier);
}
function tierMOQ() {
  return currentTier().moq;
}

/* =========================================================
   CART STATE (in-memory + best-effort localStorage)
   ========================================================= */
let cart = [];
try {
  const saved = localStorage.getItem("hbp_cart");
  if (saved) cart = JSON.parse(saved);
} catch (e) {}

// Hoisted to module scope (not local to wireCheckoutPage) so a leftover
// mounted instance is still reachable and gets destroy()'d even after the
// shopper navigates away from #/checkout and back in a later render pass
// (e.g. "Edit cart" to add another item, then return to checkout) — a
// local variable there would be discarded on navigation while Stripe.js's
// own embedded-checkout instance stayed alive, causing "You cannot have
// multiple Embedded Checkout objects" on the next mount.
let embeddedCheckout = null;
let stripeClient = null;

function persistCart() {
  try { localStorage.setItem("hbp_cart", JSON.stringify(cart)); } catch (e) {}
}
function addToCart(id) {
  const line = cart.find((l) => l.id === id);
  if (line) line.qty++;
  else cart.push({ id, qty: Math.max(1, tierMOQ()) });
  persistCart();
  renderCartCount();
  renderCartDrawer();
  openCart();
  const moqNote = tierMOQ() > 1 ? ` (min. order ${tierMOQ()})` : "";
  showToast((byId[id] ? byId[id].name : "Item") + " added to cart" + moqNote);
}
function removeLine(idx) {
  cart.splice(idx, 1);
  persistCart();
  renderCartCount();
  renderCartDrawer();
}
function setQty(idx, qty) {
  if (qty <= 0) return removeLine(idx);
  cart[idx].qty = qty;
  persistCart();
  renderCartCount();
  renderCartDrawer();
}
function cartCount() {
  return cart.reduce((s, l) => s + l.qty, 0);
}
function cartSubtotal() {
  return cart.reduce((s, l) => {
    const p = byId[l.id];
    if (!p) return s;
    return s + tierPrice(p) * l.qty;
  }, 0);
}

function renderCartCount() {
  const n = cartCount();
  document.querySelectorAll(".cart-count").forEach((el) => {
    el.textContent = n;
  });
}
function closeSearchPanel() {
  const panel = document.getElementById("searchPanel");
  const toggle = document.getElementById("searchToggle");
  if (panel) panel.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}
function renderCartDrawer() {
  const itemsEl = document.getElementById("cartItems");
  const footEl = document.getElementById("cartFoot");
  if (!itemsEl || !footEl) return;
  if (cart.length === 0) {
    itemsEl.innerHTML = '<div class="cart-empty">Your cart is empty.<br>Browse the catalog to add research peptides.</div>';
    footEl.innerHTML = "";
    return;
  }
  itemsEl.innerHTML = cart
    .map((l, idx) => {
      const p = byId[l.id];
      if (!p) return "";
      const unit = tierPrice(p);
      const moq = tierMOQ();
      return `<div class="cart-row">
        <div class="thumb"><img src="${p.image}" alt="${esc(p.name)}" loading="lazy"></div>
        <div style="flex:1;min-width:0;">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.concentration)}${moq > 1 ? ` · min. order ${moq}` : ""}</div>
          <div class="qty-row">
            <button class="qty-btn" data-qtyminus="${idx}" aria-label="Decrease quantity"${l.qty <= moq ? " disabled" : ""}>−</button>
            <input type="number" class="qty-input mono" data-qtyinput="${idx}" value="${l.qty}" min="${moq}" step="1" aria-label="Quantity">
            <button class="qty-btn" data-qtyplus="${idx}" aria-label="Increase quantity">+</button>
            <button class="remove" data-remove="${idx}">Remove</button>
          </div>
        </div>
        <div class="line-price">${fmt(unit * l.qty)}</div>
      </div>`;
    })
    .join("");
  footEl.innerHTML = `
    <div class="cart-subtotal"><span>Subtotal</span><span>${fmt(cartSubtotal())}</span></div>
    <div class="cart-note">Shipping & taxes calculated at checkout</div>
    <button class="btn btn-primary btn-block" id="checkoutBtn">Checkout</button>`;
}
function openCart() {
  document.getElementById("cartDrawer").classList.add("open");
  document.getElementById("scrim").classList.add("show");
}
function closeCartFn() {
  document.getElementById("cartDrawer").classList.remove("open");
  document.getElementById("scrim").classList.remove("show");
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2200);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function titleCase(s) {
  return String(s).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/* Delegated (re)binding for buy buttons within a given container. Safe to
   call repeatedly on freshly-inserted markup — never double-binds because
   each call only targets nodes that exist at call time. */
function wireBuyButtonsWithin(container) {
  container.querySelectorAll("[data-buy]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addToCart(btn.getAttribute("data-buy"));
    });
  });
}

/* =========================================================
   ICONS
   ========================================================= */
const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="20" r="1.4" fill="currentColor" stroke="none"/><path d="M2.5 3h2l2.2 12.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  purity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 4v5c0 5-3.4 8-7 9-3.6-1-7-4-7-9V7l7-4z"/><path d="M9 12l2 2 4-4"/></svg>',
  testing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3v6l-5 9a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M9 3h6M8 15h8"/></svg>',
  shipping: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="7" width="13" height="10" rx="1.4"/><path d="M15 10h3.5L21 13v4h-6z"/><circle cx="7" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M4 7l8 6 8-6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12l5.5 5.5L20 7"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M4.9 6l14.2 12M4.9 18L19.1 6M2 12h20"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
  flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 2h6M10 2v6.5L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 8.5V2"/><path d="M7.5 14h9"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c7 0 10.5 7 10.5 7a17 17 0 0 1-3.4 4.4M6.7 6.7C3.2 8.9 1.5 12 1.5 12s3.5 7 10.5 7a10.7 10.7 0 0 0 4.2-.85"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="5.5" width="4" height="13" rx="1"/><rect x="14" y="5.5" width="4" height="13" rx="1"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10.5 9.5l5 2.5-5 2.5v-5z" fill="currentColor" stroke="none"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3v10.8a3.3 3.3 0 1 1-2.4-3.18"/><path d="M14 3c.4 2.4 2 4 4.5 4.3"/></svg>',
  pinterest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 18c.6-2 1.4-5.3 1.4-5.3M12 12a2.6 2.6 0 1 0 5.2 0c0-2-1.5-3.6-3.6-3.6-2.4 0-4.3 1.8-4.3 4.1 0 1 .4 1.8 1 2.3"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5.5h16v11H9.5L5 20.5v-4H4v-11z"/><path d="M8 10h8M8 13.2h5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 12l16-8-6.5 16-3-6.5L4 12z"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12.5 3H5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 .6 1.4l9 9a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8l-9-9a2 2 0 0 0-.9-.3z"/><circle cx="8.2" cy="8.2" r="1.4" fill="currentColor" stroke="none"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M7 10.5l5 5 5-5"/><path d="M4.5 18.5V20a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  nfc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8.5 8.2a5.2 5.2 0 0 1 0 7.6"/><path d="M11.6 5.6a9.2 9.2 0 0 1 0 12.8"/><path d="M14.7 3a13.2 13.2 0 0 1 0 18"/><circle cx="5.3" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>'
};

/* ---- Verify Every Vial (home page NFC/QR illustration) ---- */
function verifyArtSVG() {
  return `
  <svg viewBox="0 0 220 150" fill="none" xmlns="http://www.w3.org/2000/svg" class="verify-art-svg">
    <path d="M38 44c6 2 6 10 0 12s-6 10 0 12s6 10 0 12" stroke="#6fa3e0" stroke-width="1.6" stroke-linecap="round"/>
    <rect x="80" y="28" width="24" height="18" rx="5" fill="#fff"/>
    <rect x="70" y="44" width="44" height="72" rx="22" stroke="#fff" stroke-width="2.2"/>
    <path d="M70 78h44" stroke="rgba(255,255,255,.35)" stroke-width="1.6"/>
    <rect x="140" y="50" width="52" height="52" rx="10" stroke="#fff" stroke-width="2.2"/>
    <rect x="150" y="60" width="12" height="12" rx="2" fill="#fff"/>
    <rect x="170" y="60" width="12" height="12" rx="2" stroke="#fff" stroke-width="1.6"/>
    <rect x="150" y="80" width="12" height="12" rx="2" stroke="#fff" stroke-width="1.6"/>
    <rect x="170" y="80" width="12" height="12" rx="2" fill="#fff"/>
    <text x="166" y="118" text-anchor="middle" font-family="var(--mono)" font-size="10" font-weight="700" letter-spacing="1.5" fill="#bcd2f7">QR</text>
  </svg>`;
}

/* =========================================================
   CHAT WIDGET (guided FAQ — no external AI/network calls)
   A small rule-based knowledge base: quick-reply chips and free-text
   keyword matching both draw from the same FAQ_TOPICS list below, so
   the two ways of asking stay in sync automatically.
   ========================================================= */
const FAQ_TOPICS = [
  {
    id: "order",
    label: "Placing an order",
    icon: ICONS.cart,
    keywords: ["order", "buy", "purchase", "checkout", "cart"],
    answer: "Browse the Shop, add what you need to your cart, and check out from there. Your account tier sets the minimum order quantity — 1 for Retail, 5 for Doctor, 25 for Wholesaler. Checkout is handled securely through Stripe.",
    followUp: {
      prompt: "Sure — what stage are you at?",
      options: [
        { id: "browse", label: "Still browsing", answer: "Head to Shop to browse every research compound — you can filter by category. Add anything you need to your cart, then open the cart to review it whenever you're ready." },
        { id: "moq", label: "What's the minimum order?", answer: "It depends on your account tier: Retail Customers have no minimum, Doctors need at least 5 vials, and Wholesalers need at least 25 per SKU. Sign in (or create an account) and pick your tier to see it applied." },
        { id: "checkout", label: "Ready to complete an order", answer: "Open your cart and hit Checkout — enter your shipping details and you'll be redirected to Stripe's secure payment page to complete your order." }
      ]
    }
  },
  {
    id: "pricing",
    label: "Pricing & tiers",
    icon: ICONS.tag,
    keywords: ["price", "pricing", "tier", "wholesale", "wholesaler", "doctor", "retail", "discount", "cost", "moq", "minimum"],
    answer: "Pricing depends on your account tier: Retail Customers pay standard listed pricing with no minimum, Doctors get discounted per-vial pricing with a 5-vial minimum, and Wholesalers get the deepest discount with a 25-unit minimum. You pick your tier when you first enter the site — create an account and it's saved automatically for next time.",
    followUp: {
      prompt: "Which tier applies to you?",
      options: [
        { id: "retail", label: "Retail Customer", answer: "Retail Customers pay standard listed pricing with no minimum order — the simplest way to buy." },
        { id: "doctor", label: "Doctor", answer: "Doctors get discounted per-vial pricing, with a 5-vial minimum order." },
        { id: "wholesaler", label: "Wholesaler", answer: "Wholesalers get our deepest discount, with a 25-unit minimum order per SKU." },
        { id: "how", label: "How do tiers work?", answer: "You choose your tier the first time you visit, and it's saved to your account once you sign in — remembered for next time, even from a different device." }
      ]
    }
  },
  {
    id: "research",
    label: "Research use & dosing",
    icon: ICONS.flask,
    keywords: ["dose", "dosage", "dosing", "human", "safe", "research", "consumption", "medical", "treat", "animal"],
    answer: "Everything here is sold strictly for laboratory research use — not for human or animal consumption, and nothing is approved to diagnose, treat, cure, or prevent any disease. We can't offer dosing or medical guidance; please rely on your own research protocols and each product's certificate of analysis.",
    followUp: {
      prompt: "What would you like to know?",
      options: [
        { id: "human", label: "Is this safe for human use?", answer: "No — everything here is sold strictly for laboratory research use, not for human or animal consumption, and nothing is approved to diagnose, treat, cure, or prevent any disease." },
        { id: "dosing", label: "Dosing guidance", answer: "We can't offer dosing or medical guidance of any kind — please rely on your own institution's research protocols." },
        { id: "puritydata", label: "Where's the purity data?", answer: "Every batch is HPLC-tested. You'll find the purity spec on each product page, and full certificates on our Certificates of Analysis page." }
      ]
    }
  },
  {
    id: "account",
    label: "Account & sign-in",
    icon: ICONS.lock,
    keywords: ["account", "sign in", "signin", "sign up", "signup", "login", "log in", "password", "register"],
    answer: "Click Account in the top right to sign in or create an account. Once you're signed in, your chosen pricing tier is saved — it'll be remembered the next time you log in, even from a different device.",
    followUp: {
      prompt: "What do you need help with?",
      options: [
        { id: "create", label: "Creating an account", answer: "Click Account in the top right and choose Create Account. You'll set a password and confirm it, then pick your tier — Retail, Doctor, or Wholesaler." },
        { id: "signin", label: "Signing in / trouble logging in", answer: "Click Account in the top right and sign in with your email and password. If something's not working, email Info@hoopbiopharma.com and our team can help." },
        { id: "tier", label: "How is my tier saved?", answer: "Once you're signed in, your chosen pricing tier is saved to your account automatically — you won't have to pick it again, even from a different device." }
      ]
    }
  },
  {
    id: "purity",
    label: "Purity & testing",
    icon: ICONS.purity,
    keywords: ["purity", "hplc", "coa", "certificate", "testing", "quality", "pure"],
    answer: "Every batch is verified by independent HPLC testing, and most products list ≥99% purity right on their product page, under the item name.",
    followUp: {
      prompt: "What are you looking for?",
      options: [
        { id: "cert", label: "Certificate for a specific product", answer: "Visit our Certificates of Analysis page, search by product name, SKU, or category, and open the certificate for that batch." },
        { id: "standard", label: "What purity level do you sell?", answer: "Most products list ≥99% purity by HPLC, shown right on the product page under the item name." },
        { id: "method", label: "How is it tested?", answer: "Every batch is verified by independent HPLC (high-performance liquid chromatography) testing before it's listed." }
      ]
    }
  },
  {
    id: "shipping",
    label: "Shipping & returns",
    icon: ICONS.shipping,
    keywords: ["ship", "shipping", "delivery", "deliver", "return", "refund", "track", "tracking"],
    answer: "Shipping and taxes are calculated at checkout. Full shipping and returns policies aren't published yet — for specifics on an order, reach out to Info@hoopbiopharma.com.",
    followUp: {
      prompt: "What do you need?",
      options: [
        { id: "cost", label: "Shipping cost & timing", answer: "Shipping and taxes are calculated at checkout based on your order and address — we don't have a published rate table yet." },
        { id: "returns", label: "Returns or refunds", answer: "Our returns policy isn't published yet — email Info@hoopbiopharma.com with your order details and we'll take care of it directly." },
        { id: "track", label: "Track an existing order", answer: "Email Info@hoopbiopharma.com with your order details and our team can give you an update." }
      ]
    }
  },
  {
    id: "contact",
    label: "Talk to a person",
    icon: ICONS.mail,
    keywords: ["human", "person", "agent", "help", "support", "contact", "email", "talk"],
    answer: "Of course — email Info@hoopbiopharma.com and our team will get back to you directly.",
    followUp: {
      prompt: "What's it about, so I point you the right way?",
      options: [
        { id: "orderissue", label: "An order or account", answer: "Email Info@hoopbiopharma.com with your account email and order details, and our team will follow up directly." },
        { id: "generalq", label: "A general question", answer: "Email Info@hoopbiopharma.com — our team reads every message and will get back to you." },
        { id: "wholesale", label: "Wholesale / partnership", answer: "Email Info@hoopbiopharma.com with a bit about your business and what you're looking for, and our team will follow up." }
      ]
    }
  }
];
const FAQ_PRIMARY_IDS = ["order", "pricing", "research", "account"];
const FAQ_SECONDARY_IDS = ["purity", "shipping", "contact"];

function faqTopic(id) {
  return FAQ_TOPICS.find((t) => t.id === id);
}

// Every topic with a follow-up gets an automatic "General overview" chip
// appended, so a user who doesn't want to narrow down is never stuck.
function followUpOptions(topic) {
  const opts = topic.followUp ? topic.followUp.options.slice() : [];
  opts.push({ id: "general", label: "General overview", answer: topic.answer });
  return opts;
}

function chatWidgetHTML() {
  return `
  <button type="button" class="chat-fab" id="chatFab" aria-label="Chat with HoopBioPharma" aria-expanded="false">
    ${ICONS.chat}
    <span class="chat-fab-dot" id="chatFabDot"></span>
  </button>
  <div class="chat-panel" id="chatPanel" role="dialog" aria-label="HoopBioPharma chat" hidden>
    <div class="chat-panel-head">
      <div class="chat-panel-brand">HoopBioPharma</div>
      <button type="button" class="chat-panel-close" id="chatPanelClose" aria-label="Close chat">${ICONS.close}</button>
    </div>
    <div class="chat-panel-body" id="chatPanelBody"></div>
  </div>`;
}

function chatChipsRow(ids, extra) {
  const chips = ids.map((id) => {
    const t = faqTopic(id);
    return `<button type="button" class="chat-chip" data-topic="${t.id}">${t.icon}<span>${t.label}</span></button>`;
  }).join("");
  const moreChip = extra ? `<button type="button" class="chat-chip" data-topic="__more">${ICONS.chat}<span>Something else</span></button>` : "";
  return `<div class="chat-chips">${chips}${moreChip}</div>`;
}

function subChipsRow(topic) {
  const chips = followUpOptions(topic).map((o) => {
    return `<button type="button" class="chat-chip" data-topic="${topic.id}::${o.id}">${topic.icon}<span>${o.label}</span></button>`;
  }).join("");
  return `<div class="chat-chips">${chips}</div>`;
}

function initChatWidget() {
  const mount = document.getElementById("chatWidget");
  if (!mount) return;
  mount.innerHTML = chatWidgetHTML();

  const fab = document.getElementById("chatFab");
  const fabDot = document.getElementById("chatFabDot");
  const panel = document.getElementById("chatPanel");
  const body = document.getElementById("chatPanelBody");
  let started = false;

  function scrollToBottom() {
    body.scrollTop = body.scrollHeight;
  }
  function addBotMessage(html) {
    const el = document.createElement("div");
    el.className = "chat-msg chat-msg-bot";
    el.innerHTML = html;
    body.appendChild(el);
    scrollToBottom();
  }
  function addUserMessage(text) {
    const el = document.createElement("div");
    el.className = "chat-msg chat-msg-user";
    el.textContent = text;
    body.appendChild(el);
    scrollToBottom();
  }
  function addChips(ids, extra) {
    const el = document.createElement("div");
    el.innerHTML = chatChipsRow(ids, extra);
    body.appendChild(el.firstElementChild);
    scrollToBottom();
  }
  function addSubChips(topic) {
    const el = document.createElement("div");
    el.innerHTML = subChipsRow(topic);
    body.appendChild(el.firstElementChild);
    scrollToBottom();
  }
  function startConversation() {
    if (started) return;
    started = true;
    addBotMessage("Hi there \u{1F44B}! Welcome to HoopBioPharma — I can help with pricing, orders, purity testing, and more. What do you need?");
    addChips(FAQ_PRIMARY_IDS, true);
  }
  function handleTopic(id) {
    if (id === "__more") {
      addUserMessage("Something else");
      addBotMessage("Here are a few more topics:");
      addChips(FAQ_SECONDARY_IDS, false);
      return;
    }
    // "topicId::optionId" — a follow-up narrowing choice was picked.
    if (id.indexOf("::") !== -1) {
      const parts = id.split("::");
      const topic = faqTopic(parts[0]);
      if (!topic) return;
      const opt = followUpOptions(topic).find((o) => o.id === parts[1]);
      if (!opt) return;
      addUserMessage(opt.label);
      addBotMessage(opt.answer);
      addChips(FAQ_PRIMARY_IDS, true);
      return;
    }
    const topic = faqTopic(id);
    if (!topic) return;
    addUserMessage(topic.label);
    if (topic.followUp) {
      addBotMessage(topic.followUp.prompt);
      addSubChips(topic);
    } else {
      addBotMessage(topic.answer);
      addChips(FAQ_PRIMARY_IDS, true);
    }
  }

  fab.addEventListener("click", () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    fab.setAttribute("aria-expanded", String(opening));
    if (opening) {
      fabDot.hidden = true;
      startConversation();
    }
  });
  document.getElementById("chatPanelClose").addEventListener("click", () => {
    panel.hidden = true;
    fab.setAttribute("aria-expanded", "false");
  });
  body.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-topic]");
    if (chip) handleTopic(chip.getAttribute("data-topic"));
  });
}

/* =========================================================
   ROUTER
   ========================================================= */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const qIdx = h.indexOf("?");
  const path = qIdx >= 0 ? h.slice(0, qIdx) : h;
  const query = {};
  if (qIdx >= 0) {
    h.slice(qIdx + 1).split("&").forEach((pair) => {
      if (!pair) return;
      const kv = pair.split("=");
      query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
    });
  }
  return { path: path.split("/").filter(Boolean), query };
}
function queryString(q) {
  const parts = Object.keys(q)
    .filter((k) => q[k])
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(q[k]));
  return parts.length ? "?" + parts.join("&") : "";
}

function navigate() {
  const r = parseHash();
  const seg = r.path[0] || "home";
  const app = document.getElementById("app");
  window.scrollTo(0, 0);
  closeCartFn();
  let inner;
  if (seg === "home" || seg === "") inner = viewHome();
  else if (seg === "gallery") inner = viewGallery();
  else if (seg === "shop" && r.path[1]) inner = viewProduct(r.path[1]);
  else if (seg === "shop") inner = viewShop(r.query);
  else if (seg === "about") inner = viewAbout();
  else if (seg === "wholesale") inner = viewWholesale();
  else if (seg === "terms") inner = viewTerms();
  else if (seg === "research-use-only") inner = viewResearchUseOnly();
  else if (seg === "contact") inner = viewContact();
  else if (seg === "coa") inner = viewCOA();
  else if (seg === "checkout") inner = viewCheckout();
  else if (seg === "order-confirmation") inner = viewOrderConfirmation(r.query);
  else if (seg === "admin" && r.path[1] === "orders") inner = viewAdminOrders();
  else if (seg === "admin" && r.path[1] === "promo-codes") inner = viewAdminPromoCodes();
  else if (seg === "admin") inner = viewAdmin();
  else if (seg === "compare") inner = viewCompare();
  else if (seg === "methodology") inner = viewMethodology();
  else if (seg === "glossary" && r.path[1]) inner = viewGlossaryTerm(r.path[1]);
  else if (seg === "glossary") inner = viewGlossary();
  else inner = viewHome();
  app.innerHTML = headerHTML() + `<main>${inner}</main>` + footerHTML();
  wireDynamic();
  document.querySelectorAll("nav.primary a, .header-actions a[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-nav") === seg);
  });
  const infoBtn = document.getElementById("infoDropdownBtn");
  if (infoBtn) infoBtn.classList.toggle("active", ["coa", "compare", "methodology", "glossary"].includes(seg));
}

function headerHTML() {
  const flyout = CATEGORIES.map(
    (c) => `<a href="#/shop?cat=${c.id}"><span class="dot" style="background:var(${c.var})"></span>${c.name}</a>`
  ).join("");
  return `
  <div class="announce">FOR LABORATORY RESEARCH USE ONLY<span class="sep">·</span><b>NOT FOR HUMAN OR ANIMAL CONSUMPTION</b></div>
  <header class="site">
    <div class="wrap header-inner">
      <button class="icon-btn nav-toggle" id="navToggle" aria-label="Open menu">${ICONS.menu}</button>
      <nav class="primary" id="primaryNav">
        <a href="#/" data-nav="home">Home</a>
        <a href="#/about" data-nav="about">About</a>
        <div class="cat-menu-wrap">
          <a href="#/shop" data-nav="shop">Shop</a>
          <div class="cat-flyout">${flyout}</div>
        </div>
        <a href="#/wholesale" data-nav="wholesale">Wholesale</a>
        <div class="nav-dropdown" id="infoDropdown">
          <button type="button" class="nav-dropdown-btn" id="infoDropdownBtn" aria-expanded="false" aria-controls="infoDropdownPanel">
            Peptide Information
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="nav-dropdown-panel" id="infoDropdownPanel" hidden>
            <a href="#/glossary" data-nav="glossary">Glossary</a>
            <a href="#/methodology" data-nav="methodology">Our Methodology</a>
            <a href="#/compare" data-nav="compare">Compare Peptides</a>
            <a href="#/coa" data-nav="coa">Certificates of Analysis</a>
          </div>
        </div>
      </nav>
      <a href="#/" class="logo"><img src="/images/logo-hoopbiopharma-signin.png" alt="HoopBioPharma"></a>
      <div class="header-actions">
        <a href="#/gallery" class="nav-text-link" data-nav="gallery">Gallery</a>
        <a href="#/contact" class="nav-text-link" data-nav="contact">Contact</a>
        <div class="account-menu-wrap" id="accountMenuWrap">
          <button type="button" class="nav-text-link" id="accountBtn" aria-haspopup="true">Account</button>
          <div class="account-dropdown-panel" id="accountDropdownPanel">
            ${currentUser ? `<div class="account-user-email" title="${esc(currentUser.email)}">${esc(currentUser.email)}</div>` : ""}
            ${isAdmin() ? `<a href="#/admin" class="account-admin-link">Admin Portal</a>` : ""}
            ${isAdmin() ? `<a href="#/admin/orders" class="account-admin-link" data-nav="admin-orders">Orders</a>` : ""}
            ${isAdmin() ? `<a href="#/admin/promo-codes" class="account-admin-link" data-nav="admin-promo">Promo Codes</a>` : ""}
            ${currentUser
              ? `<button type="button" class="account-logout-btn" id="logoutBtn">Log Out</button>`
              : `<button type="button" class="account-logout-btn" id="signinTrigger">Sign In</button>`}
          </div>
        </div>
        <button type="button" class="nav-text-link" id="searchToggle" aria-label="Search" aria-expanded="false">Search</button>
        <button type="button" class="nav-text-link" id="cartBtn" aria-label="Open cart">Cart (<span class="cart-count">0</span>)</button>
      </div>
    </div>
    <div class="search-panel" id="searchPanel" hidden>
      <div class="wrap">
        <div class="search-bar-full">
          <span aria-hidden="true">${ICONS.search}</span>
          <input type="text" id="searchInput" placeholder="Search ${PRODUCTS.length} products…" aria-label="Search products">
          <button type="button" class="icon-btn" id="searchClose" aria-label="Close search">${ICONS.close}</button>
        </div>
      </div>
    </div>
  </header>`;
}

function footerHTML() {
  return `
  <footer class="site">
    <div class="footer-content">
    <div class="wrap footer-grid">
      <div class="footer-col footer-newsletter">
        <h4>Join the HoopBioPharma research list.</h4>
        <p>Updates on new compounds, restocks, and research notes.</p>
        <form class="newsletter-form" id="newsletterForm">
          <div class="field-u"><input type="email" placeholder="Email address" required aria-label="Email address"></div>
          <button type="submit" class="btn btn-secondary btn-sm">Subscribe</button>
        </form>
      </div>
      <div class="footer-col"><h4>Navigate</h4>
        <a href="#/">Home</a><a href="#/about">About</a><a href="#/shop">Shop</a><a href="#/wholesale">Wholesale</a><a href="#/gallery">Gallery</a><a href="#/contact">Contact</a>
      </div>
      <div class="footer-col"><h4>Peptide Information</h4>
        <a href="#/glossary">Glossary</a><a href="#/methodology">Our Methodology</a><a href="#/compare">Compare Peptides</a><a href="#/coa">Certificates of Analysis</a>
      </div>
      <div class="footer-col"><h4>Categories</h4>
        <a href="#/shop?cat=growth-hormone">Growth Hormone</a><a href="#/shop?cat=repair-skin">Repair &amp; Skin</a><a href="#/shop?cat=weight-management">Weight Management</a><a href="#/shop?cat=cognitive-longevity">Cognitive &amp; Longevity</a><a href="#/shop?cat=sexual-health">Sexual Health</a><a href="#/shop?cat=blends">Peptide Blends</a>
      </div>
      <div class="footer-col"><h4>Official</h4>
        <a href="#/research-use-only" class="footer-text-link" data-nav="research-use-only">Research Use Only</a>
        <a href="#/terms" class="footer-text-link" data-nav="terms">Terms</a>
      </div>
    </div>
    <div class="wrap footer-legal">
      <div class="footer-legal-box">
        <h5>Regulatory Compliance &amp; Research Use Only Statement</h5>
        <p>Disclaimer: every compound and peptide listed in this catalog is supplied strictly for laboratory research use. They are not intended for human consumption, veterinary use, diagnostic testing, or any clinical application. Purchasers must be 21 years of age or older, and by using this site you agree to comply with all applicable local, state, and federal laws governing the purchase and handling of research compounds. Misuse of any product sold here is strictly prohibited. <a href="#/research-use-only">Read full statement</a></p>
        <h5>FDA Disclaimer</h5>
        <p>The statements and products on this site have not been evaluated by the U.S. Food and Drug Administration and are not intended to diagnose, treat, cure, or prevent any disease. HoopBioPharma is not a compounding pharmacy and does not manufacture products for human use — every compound we sell is supplied exclusively for laboratory and analytical research.</p>
        <p>HoopBiopharma is a B2B chemical reagent supplier — it is not a pharmacy or compounding facility as defined under 503A or 503B of the Federal Food, Drug, and Cosmetic Act, and does not dispense, prescribe, or counsel on therapeutic use of any compound. Buyers are professional researchers and must handle all materials in compliance with applicable local, state, and federal law.</p>
      </div>
    </div>
    </div>
  </footer>`;
}

/* =========================================================
   VIEWS
   ========================================================= */
function productCard(item, index) {
  const c = catInfo(item.category);
  const lot = "№ " + String(index + 1).padStart(3, "0");
  const purityLine = `${item.specifications.Purity || "≥99%"} HPLC${item.isFamily ? ` · ${item.variantCount} dosages` : ""}`;
  const priceLabel = item.isFamily ? `From ${fmt(tierPrice(item))}` : fmt(tierPrice(item));
  return `<div class="card" style="--cat:var(${c.var})">
    <a class="card-link" href="#/shop/${item.id}">
      <div class="card-media">
        ${item.isNew ? '<span class="badge-new">new</span>' : ""}
        <img src="${item.image}" alt="${esc(item.name)}" loading="lazy">
      </div>
      <div class="card-info">
        <span class="lot-badge mono">${lot}</span>
        <span class="card-name-sm">${esc(item.name)}</span>
        <span class="card-purity">${purityLine}</span>
      </div>
    </a>
    <div class="card-buy-row">
      <span class="card-price">${priceLabel}</span>
      ${item.isFamily ? `<span class="card-doses mono">${item.variantCount} doses</span>` : `<button class="card-addbtn" type="button" data-buy="${item.id}">Add to Cart</button>`}
    </div>
    ${item.isFamily ? `<a href="#/shop/${item.id}" class="card-subbtn">Select Dosage</a>` : ""}
  </div>`;
}

/* ---- Category showcase grid (home page) ---- */
const SHOWCASE = [
  { cat: "cognitive-longevity", size: "lg", image: "/images/stack-dsip.png", bg: "var(--tile-cognitive)",
    tagline: "Neuromodulatory peptides studied for sleep, focus, and cellular longevity." },
  { cat: "weight-management", size: "lg", image: "/images/stack-glp3-30mg.png", bg: "var(--tile-weight)",
    tagline: "Incretin and triple-agonist compounds for metabolic and appetite research." },
  { cat: "growth-hormone", size: "sm", image: "/images/tiles/tile-growth-hormone.png", bg: "var(--tile-growth)",
    tagline: "GHRH analogs and secretagogues for growth axis and recovery research." },
  { cat: "repair-skin", size: "sm", image: "/images/stack-kpv.png", bg: "var(--tile-repair)",
    tagline: "Regenerative and dermal peptides for tissue repair and wound-healing research." },
  { cat: "sexual-health", size: "sm", image: "/images/tiles/tile-sexual-health.png", bg: "var(--tile-sexual)",
    tagline: "Melanocortin and gonadotropin compounds for sexual health research." },
  { cat: "blends", size: "sm", image: "/images/tiles/tile-blends.png", bg: "linear-gradient(135deg,var(--tile-weight),var(--tile-repair))",
    tagline: "Multi-peptide combinations formulated for synergistic research protocols." }
];

function showcaseGridHTML() {
  return SHOWCASE.map((s) => {
    const c = catInfo(s.cat);
    const sizeClass = s.size === "lg" ? "showcase-tile" : "showcase-tile showcase-tile--sm";
    return `<a class="${sizeClass}" href="#/shop?cat=${s.cat}" style="--tile-bg:${s.bg}">
      <div class="showcase-media"><img src="${s.image}" alt="${esc(c.name)} products" loading="lazy"></div>
      <div class="showcase-copy">
        <h3>${esc(c.name)}</h3>
        <p>${esc(s.tagline)}</p>
      </div>
      <span class="showcase-learnmore">Learn More <span class="ring">${ICONS.arrowRight}</span></span>
    </a>`;
  }).join("");
}

/* ---- Common Questions accordion (home page) ----
   Reuses the same FAQ_TOPICS knowledge base that powers the chat widget,
   so the two stay in sync — just phrased as full questions here. ---- */
const HOME_FAQ_IDS = [
  { id: "order", q: "How do I place an order?" },
  { id: "pricing", q: "How does pricing work across account tiers?" },
  { id: "purity", q: "How is purity tested and verified?" },
  { id: "research", q: "Are these peptides safe for human or animal use?" },
  { id: "shipping", q: "What are your shipping and returns policies?" },
  { id: "account", q: "How do I create an account or sign in?" },
  { id: "contact", q: "How do I talk to a real person?" }
];

function faqAccordionHTML() {
  return HOME_FAQ_IDS.map(({ id, q }, i) => {
    const t = faqTopic(id);
    if (!t) return "";
    return `<div class="faq-row${i === 0 ? " open" : ""}">
      <button type="button" class="faq-row-head" data-faqtoggle aria-expanded="${i === 0 ? "true" : "false"}">
        <span>${esc(q)}</span>
        <span class="faq-row-icon">${ICONS.plus}</span>
      </button>
      <div class="faq-row-body"><div class="faq-row-body-in"><p>${esc(t.answer)}</p></div></div>
    </div>`;
  }).join("");
}

/* ---- Protocol / stack spotlight (real catalog data) ---- */
const STACK_IDS = ["selank-10mg", "kpv-10mg", "glp3-30mg", "glp2-60mg"];
const STACK_IMAGE_OVERRIDES = {
  "selank-10mg": "/images/stack-selank.png",
  "kpv-10mg": "/images/stack-kpv.png",
  "glp3-30mg": "/images/stack-glp3-30mg.png",
  "glp2-60mg": "/images/stack-glp2-60mg.png"
};
let stackIndex = 0;
let stackAutoplay = false;
let stackTimer = null;

function stackFacts() {
  return [
    { icon: ICONS.flask, label: "lab-verified compound" },
    { icon: ICONS.purity, label: "purity reported per vial" },
    { icon: ICONS.snow, label: "cold-chain shipped" },
    { icon: ICONS.testing, label: "for research use only" }
  ];
}

function stackSpotlightHTML() {
  const id = STACK_IDS[stackIndex];
  const p = byId[id];
  if (!p) return "";
  const specLines = Object.keys(p.specifications)
    .filter((k) => k !== "Appearance" && k !== "Storage" && k !== "Purity")
    .slice(0, 3)
    .map((k) => `${k.toLowerCase()}: ${p.specifications[k]}`);
  const checklist = [...specLines, `purity reported per vial: ${p.specifications.Purity || "≥99%"}`, "for research use only"]
    .map((line) => `<li>${ICONS.check}<span>${esc(line)}</span></li>`)
    .join("");
  const facts = stackFacts()
    .map((f) => `<div class="stack-fact"><span class="ic">${f.icon}</span><span>${f.label}</span></div>`)
    .join("");
  const purity = p.specifications.Purity || "≥99%";
  return `
    <div class="stack-copy">
      <div class="stack-nav">
        <span class="idx mono">FEATURED PROTOCOLS ${stackIndex + 1}/${STACK_IDS.length}</span>
        <button type="button" data-stackplay aria-label="${stackAutoplay ? "Pause" : "Play"} carousel">${stackAutoplay ? ICONS.pause : ICONS.play}</button>
        <button type="button" data-stackprev aria-label="Previous protocol">${ICONS.arrowLeft}</button>
        <button type="button" data-stacknext aria-label="Next protocol">${ICONS.arrowRight}</button>
      </div>
      <h3>${esc(p.name)}</h3>
      <span class="purity-pill"><span class="dot"></span>${purity} HPLC</span>
      <p class="desc">${esc(p.description)}</p>
      <ul class="stack-check">${checklist}</ul>
      <div class="stack-vial-row">
        <span class="stack-vial-label mono">${esc(p.concentration)} VIAL</span>
        <div class="stack-vial-line">
          <span class="stack-dose-pill">${esc(p.concentration)} fill</span>
          <span class="stack-price">${fmt(tierPrice(p))}</span>
        </div>
      </div>
      <button class="btn btn-primary" data-buy="${p.id}">Add to Cart</button>
      <a href="#/shop/${p.id}" class="stack-learnmore">learn more ${ICONS.arrowRight}</a>
    </div>
    <div class="stack-media">
      ${p.isNew ? '<span class="new-badge">new</span>' : ""}
      <img src="${STACK_IMAGE_OVERRIDES[p.id] || p.image}" alt="${esc(p.name)}">
    </div>
    <div class="stack-facts">${facts}</div>`;
}

function stackGoTo(delta) {
  const block = document.getElementById("stackBlock");
  if (!block) return;
  stackIndex = (stackIndex + delta + STACK_IDS.length) % STACK_IDS.length;
  block.innerHTML = stackSpotlightHTML();
  wireStackSpotlight();
}

function stackStopAutoplay() {
  if (stackTimer) { clearInterval(stackTimer); stackTimer = null; }
}

function stackStartAutoplay() {
  stackStopAutoplay();
  stackTimer = setInterval(() => {
    if (!document.getElementById("stackBlock")) { stackStopAutoplay(); return; }
    stackGoTo(1);
  }, 4500);
}

function wireStackSpotlight() {
  const block = document.getElementById("stackBlock");
  if (!block) return;
  wireBuyButtonsWithin(block);
  const play = block.querySelector("[data-stackplay]");
  const prev = block.querySelector("[data-stackprev]");
  const next = block.querySelector("[data-stacknext]");
  if (play) play.addEventListener("click", () => {
    stackAutoplay = !stackAutoplay;
    if (stackAutoplay) stackStartAutoplay(); else stackStopAutoplay();
    block.innerHTML = stackSpotlightHTML();
    wireStackSpotlight();
  });
  if (prev) prev.addEventListener("click", () => stackGoTo(-1));
  if (next) next.addEventListener("click", () => stackGoTo(1));
}

/* Dosage-pill wiring for a family product page: swapping dosage re-renders
   just the #productPane contents in place, same pattern as the stack
   spotlight carousel above — no route change, no scroll jump. */
function wireProductPane() {
  const pane = document.getElementById("productPane");
  if (!pane) return;
  wireBuyButtonsWithin(pane);
  pane.querySelectorAll("[data-dosesel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fid = btn.getAttribute("data-family");
      const vid = btn.getAttribute("data-dosesel");
      const fam = familyById[fid];
      if (!fam) return;
      familySelection[fid] = vid;
      pane.innerHTML = productPaneHTML(fam, vid);
      wireProductPane();
    });
  });
}

/* ---- Quality You Can Verify (home page tabbed proof section) ---- */
const QUALITY_TABS = [
  {
    key: "potency", tab: "Potency", title: "Verified Potency", badge: "HPLC Analysis",
    desc: "Every vial is tested to confirm it contains exactly what the label says — down to the milligram.",
    why: "No guessing games. You get the exact concentration you paid for, every single time."
  },
  {
    key: "purity", tab: "Purity", title: "Verified Purity", badge: "≥99% Purity",
    desc: "Independent HPLC analysis confirms every batch meets or exceeds our ≥99% purity standard before it ships.",
    why: "Contaminants and byproducts skew research results. We publish the real number, not a rounded one."
  },
  {
    key: "stability", tab: "Stability", title: "Verified Stability", badge: "Lyophilized",
    desc: "Vials are freeze-dried under controlled conditions and cold-chain packed to preserve potency from our facility to your bench.",
    why: "A compound that degrades in transit gives you bad data. Stability testing keeps results reproducible."
  },
  {
    key: "safety", tab: "Safety", title: "Verified Handling", badge: "Research Use Only",
    desc: "Every batch ships with documentation, batch tracking, and clear research-use-only labeling — nothing enters our catalog without it.",
    why: "Chain of custody matters. You always know exactly what batch you're working with."
  },
  {
    key: "consistency", tab: "Consistency", title: "Verified Consistency", badge: "Batch-to-Batch",
    desc: "We re-test every new batch against the same reference standards, so potency and purity don't drift over time.",
    why: "Reproducibility depends on consistency. What you ordered last month is what you get this month."
  }
];
function qvPanelHTML(key) {
  const t = QUALITY_TABS.find((x) => x.key === key) || QUALITY_TABS[0];
  return `
    <h3>${esc(t.title)}</h3>
    <p>${esc(t.desc)}</p>
    <div class="qv-why">
      <span class="qv-why-label">Why It Matters</span>
      <p>${esc(t.why)}</p>
    </div>`;
}
function qvTabsHTML(activeKey) {
  return QUALITY_TABS.map(
    (t) => `<button type="button" class="chip qv-tab${t.key === activeKey ? " active" : ""}" data-qvtab="${t.key}">${esc(t.tab)}</button>`
  ).join("");
}

function viewHome() {
  const heroProduct = displayItem("glp3-10mg");
  const totalProducts = PRODUCTS.length;

  return `
  <section class="hero">
    <video class="hero-bg-video" autoplay loop muted playsinline disablepictureinpicture aria-hidden="true">
      <source src="/media/hero-bg-water.webm" type="video/webm">
      <source src="/media/hero-bg-water.mp4" type="video/mp4">
    </video>
    <div class="hero-bg-overlay"></div>
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <span class="eyebrow">Research-Grade · ${totalProducts}+ Compounds</span>
        <h1>Precision at<br>Every Vial</h1>
        <p class="lede"><strong>LEADING THE FUTURE OF PEPTIDE SCIENCE.</strong><br>Engineered by Science. Defined by Quality.</p>
        <span class="hero-badge">✓ USA Manufactured &amp; Verified</span>
      </div>
      <div class="hero-media">
        <div class="hero-vial-frame">
          <video autoplay loop muted playsinline disablepictureinpicture aria-label="${esc(heroProduct.name)} vial, rotating">
            <source src="/media/hero-vial-loop.webm" type="video/webm">
            <source src="/media/hero-vial-loop.mp4" type="video/mp4">
          </video>
        </div>
      </div>
    </div>
    <audio id="brandVoiceover" preload="auto" style="display:none">
      <source src="/media/brand-voiceover.ogg" type="audio/ogg">
      <source src="/media/brand-voiceover.mp3" type="audio/mpeg">
    </audio>
    <button type="button" class="sound-toggle" data-sound-toggle aria-pressed="true" aria-label="Mute brand voiceover">
      <svg class="sound-toggle-icon" data-icon-off width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" hidden><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="19.5" y1="5" x2="4.5" y2="19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <svg class="sound-toggle-icon" data-icon-on width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M20 6a9 9 0 0 1 0 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <span class="sound-toggle-label" data-sound-label>Sound on</span>
    </button>
  </section>

  <section>
    <div class="wrap mission-block">
      <div class="mission-media">
        <img src="/images/premium-podium.jpg" alt="Four HoopBioPharma vials — GLP-2 TZ, GHK-CU, NAD+, and BPC-157/TB-500 — displayed on a white podium">
      </div>
      <div class="mission-copy">
        <span class="eyebrow">Our Mission</span>
        <h2 style="margin-top:10px;">To supply research-grade peptides whose purity is verified and clearly reported, not just claimed.</h2>
        <a href="#/about" class="btn btn-outline">Our Values</a>
        <div class="mission-values">
          <div class="mission-value"><div><div class="t">Independently Tested</div><div class="s">Every batch is independently third-party tested before it reaches your lab.</div></div></div>
          <div class="mission-value"><div><div class="t">HPLC-Verified Purity</div><div class="s">Purity verified through high-performance liquid chromatography analysis.</div></div></div>
          <div class="mission-value"><div><div class="t">Secure Checkout</div><div class="s">Every order is processed through an encrypted, privacy-protected checkout.</div></div></div>
          <div class="mission-value"><div><div class="t">Research-Grade</div><div class="s">Produced to ≥99% purity for laboratory research applications.</div></div></div>
        </div>
      </div>
    </div>
  </section>

  <section class="tight">
    <div class="wrap">
      <div class="section-head"><h2>Shop by Category</h2></div>
      <div class="showcase-grid">${showcaseGridHTML()}</div>
    </div>
  </section>

  <section class="verify-section">
    <div class="verify-banner">
      <img class="bg-img" src="/images/verify-banner.jpg" alt="">
      <div class="wrap">
        <div class="verify-banner-inner">
          <span class="eyebrow" style="color:rgba(255,255,255,.6);">Quality &amp; Testing</span>
          <h2 style="margin-top:10px;">Tested. Verified. Trusted.</h2>
          <p>HoopBioPharma peptides are produced to ≥99% purity and independently third-party tested, with HPLC analysis behind every batch. For laboratory research use only.</p>
          <a href="#/about" class="btn btn-secondary">Learn About Our Testing</a>
        </div>
      </div>
    </div>
  </section>

  <section class="tight">
    <div class="wrap">
      <div class="section-head">
        <div>
          <span class="eyebrow">Authentication</span>
          <h2 style="margin-top:10px;">Verify Every Vial</h2>
        </div>
        <a href="#/coa" class="btn btn-outline">View Certificates</a>
      </div>
      <div class="verify-cards">
        <div class="verify-card">
          <span class="verify-card-icon">${ICONS.nfc}</span>
          <span class="verify-card-label">NFC &amp; COA Access</span>
          <p>Optional NFC cap chips enable tap-to-verify authentication. Every shipment links to published batch documentation — searchable online or via NFC tap.</p>
          <ul class="verify-card-list">
            <li>Tap-to-verify vial caps</li>
            <li>Digital COA library</li>
            <li>Anti-counterfeit batch tracking</li>
          </ul>
        </div>
        <div class="verify-card verify-card-graphic">
          <div class="verify-card-art">${verifyArtSVG()}</div>
          <span class="verify-card-label">NFC &amp; QR Verification</span>
          <p>Optional cap chips and label QR codes open batch Certificates of Analysis in any mobile browser — no app required.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="tight">
    <div class="wrap qv-block">
      <div class="qv-copy">
        <h2>Quality you can verify,<br>not just trust.</h2>
        <div class="qv-divider"></div>
        <p class="lede">Every batch is independently tested by accredited U.S.A. laboratories. We don't ask you to take our word for it — we give you the proof.</p>
        <div class="qv-stats">
          <div class="qv-stat"><b>≥99%</b><span>Purity Guaranteed</span></div>
          <div class="qv-stat"><b>5</b><span>Quality Checks</span></div>
          <div class="qv-stat"><b>100%</b><span>US Verified</span></div>
        </div>
        <div class="qv-tabs" role="tablist" id="qvTabs">${qvTabsHTML("potency")}</div>
        <div class="qv-panel-copy" id="qvPanelCopy">${qvPanelHTML("potency")}</div>
        <div class="qv-cta">
          <a href="#/shop" class="btn btn-primary">Shop Now</a>
        </div>
      </div>
      <div class="qv-media">
        <img class="qv-media-img" src="/images/quality-verify-banner.jpg" alt="Gloved hand holding a HoopBioPharma GLP-3 RT vial in the lab, with tested vials in the background">
        <div class="qv-media-scrim"></div>
        <span class="qv-proof-badge">99%+ Purity<small>Verified by HPLC</small></span>
        <a href="#/coa" class="qv-proof-btn">See the Proof ${ICONS.arrowRight}</a>
      </div>
    </div>
  </section>

  <section class="premium-banner">
    <div class="wrap premium-grid">
      <div class="premium-media">
        <img class="premium-podium-img" src="/images/mission-kit.jpg" alt="HoopBioPharma research vials packed in a travel case">
      </div>
      <div class="premium-copy">
        <h2>Premium Research<br>Peptides<span class="dot">.</span></h2>
        <p class="lede">We formulate and distribute research-grade peptides produced to ≥99% purity. Every batch undergoes independent HPLC testing to verify what's reported on the label.</p>
        <div class="premium-stats">
          <div class="premium-stat"><b>≥99%</b><span>HPLC Purity</span></div>
          <div class="premium-stat"><b>100%</b><span>Lab Verified</span></div>
          <div class="premium-stat"><b>USA</b><span>Manufactured</span></div>
        </div>
        <div class="premium-actions">
          <a href="#/shop" class="btn btn-primary">Shop Now</a>
          <a href="#/coa" class="btn btn-outline">COAs</a>
        </div>
      </div>
    </div>
  </section>

  <section class="tight">
    <div class="wrap">
      <div class="section-head"><h2>Featured Protocols</h2></div>
      <div class="stack-block" id="stackBlock">${stackSpotlightHTML()}</div>
    </div>
  </section>

  <section class="panel-bg">
    <div class="wrap faq-block">
      <div class="faq-copy">
        <span class="eyebrow">Support</span>
        <h2 style="margin-top:10px;">Common Questions</h2>
        <p class="lede">Everything you need to know about ordering, pricing tiers, and how we test and report purity. Can't find it here?</p>
        <button type="button" class="btn btn-outline" id="faqChatBtn">Chat With Us</button>
        <div class="faq-image">
          <img src="/images/coa-lab.jpg" alt="HoopBioPharma lab with HPLC testing equipment and Certificates of Analysis">
        </div>
      </div>
      <div class="faq-list">${faqAccordionHTML()}</div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="cta-banner">
        <div><h2>Ready to Explore Our Catalog?</h2><p>Browse our complete collection of research peptides or get in touch for custom inquiries.</p></div>
        <a href="#/shop" class="btn btn-primary">Browse All Products</a>
      </div>
    </div>
  </section>`;
}

function viewShop(query) {
  const cat = query.cat || "";
  const sort = query.sort || "featured";
  const search = (query.q || "").toLowerCase();
  let list = SHOP_ITEMS.slice();
  if (cat) list = list.filter((p) => p.category === cat);
  if (search) list = list.filter((p) => p.name.toLowerCase().includes(search) || p.description.toLowerCase().includes(search));
  if (sort === "price-asc") list.sort((a, b) => a.price - b.price);
  else if (sort === "price-desc") list.sort((a, b) => b.price - a.price);
  else if (sort === "new") list.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0));

  const chips =
    `<button class="chip${cat === "" ? " active" : ""}" data-catchip="">Shop All</button>` +
    CATEGORIES.map((c) => `<button class="chip${cat === c.id ? " active" : ""}" data-catchip="${c.id}">${c.name}</button>`).join("");

  return `
  <div class="page-hero shop-hero"><div class="wrap">
    <h1 class="shop-title">${cat ? catInfo(cat).name : "Shop All"}</h1>
  </div></div>
  <section style="padding-top:12px;">
    <div class="wrap">
      <div class="filter-row cat-scroll" id="catChips">${chips}</div>
      <div class="shop-toolbar">
        <select class="sort" id="sortSelect">
          <option value="featured"${sort === "featured" ? " selected" : ""}>Sort: Featured</option>
          <option value="new"${sort === "new" ? " selected" : ""}>Sort: New arrivals</option>
          <option value="price-asc"${sort === "price-asc" ? " selected" : ""}>Sort: Price low to high</option>
          <option value="price-desc"${sort === "price-desc" ? " selected" : ""}>Sort: Price high to low</option>
        </select>
        <span class="result-count">${list.length} PRODUCTS</span>
      </div>
      <div class="product-grid" id="productGrid">${list.map((p, i) => productCard(p, i)).join("")}</div>
      ${list.length === 0 ? '<p class="muted" style="padding:40px 0;text-align:center;">No products match your search.</p>' : ""}
    </div>
  </section>`;
}

/* Product page for a multi-dosage family: shows the currently selected
   variant's data with a dosage-pill selector. Re-rendered in place (no
   route change) whenever a dosage pill is clicked — see wireProductPane(). */
function productPaneHTML(fam, variantId) {
  const v = byId[variantId] || byId[fam.variantIds[0]];
  const c = catInfo(v.category);
  const specRows = ["Appearance", "Storage", "Purity"]
    .filter((k) => v.specifications[k])
    .map((k) => `<div class="spec-row"><dt>${esc(k)}</dt><dd>${esc(v.specifications[k])}</dd></div>`)
    .join("");
  const dosePills = fam.variantIds
    .map((vid) => {
      const vp = byId[vid];
      return `<button type="button" class="dose-pill${vp.id === v.id ? " active" : ""}" data-dosesel="${vp.id}" data-family="${fam.id}">${esc(vp.concentration)}</button>`;
    })
    .join("");
  const related = SHOP_ITEMS.filter((x) => x.category === v.category && x.id !== fam.id).slice(0, 4);

  return `
  <div class="page-hero"><div class="wrap">
    <div class="breadcrumb"><a href="#/">Home</a> / <a href="#/shop">Shop</a> / <a href="#/shop?cat=${c.id}">${c.name}</a> / ${esc(fam.name)}</div>
  </div></div>
  <section>
    <div class="wrap">
      <div class="pd-grid">
        <div class="pd-media"><img src="${v.image}" alt="${esc(v.name)}"></div>
        <div class="pd-info">
          <span class="purity-pill"><span class="dot"></span>${v.specifications.Purity || "≥99%"} HPLC</span>
          <h1>${esc(fam.name)}</h1>
          <div class="pd-sku">SKU ${esc(v.sku)} · ${esc(v.tagline)}</div>
          <p class="pd-desc">${esc(v.description)}</p>
          <div class="pd-dose-row">
            <span class="pd-dose-label mono">Dosage — ${esc(v.concentration)}</span>
            <div class="pd-dose-pills" id="doseSelector">${dosePills}</div>
          </div>
          ${currentTier().badge ? `<span class="tier-badge">${esc(currentTier().badge)}</span>` : ""}
          <div class="pd-price-block"><span class="price">${fmt(tierPrice(v))}</span></div>
          ${tierMOQ() > 1 ? `<div class="pd-moq">Minimum order: ${tierMOQ()} units</div>` : ""}
          <div class="pd-buy-row">
            <button class="btn btn-primary" data-buy="${v.id}">Add to Cart</button>
          </div>
          ${fam.brochure ? `<a class="btn btn-secondary pd-brochure-btn" href="${fam.brochure}" target="_blank" rel="noopener">${ICONS.download}Download Brochure</a>` : ""}
          <dl class="spec-table">${specRows}</dl>
        </div>
      </div>
    </div>
  </section>
  ${
    related.length
      ? `<section class="panel-bg"><div class="wrap"><div class="section-head"><h2>Related in ${c.name}</h2></div><div class="product-grid">${related
          .map((r, i) => productCard(r, i))
          .join("")}</div></div></section>`
      : ""
  }`;
}

function viewProduct(id) {
  // fam-id visited directly (from a "Select Dosage" card), or a specific
  // SKU id that belongs to a family (from a direct/legacy link) — either
  // way, render the family page with a dosage pre-selected.
  const directFam = familyById[id];
  const memberFam = !directFam && byId[id] && byId[id].family ? familyById[byId[id].family] : null;
  const fam = directFam || memberFam;
  if (fam) {
    const selId = memberFam ? id : familySelection[fam.id] || fam.variantIds[0];
    familySelection[fam.id] = selId;
    return `<div id="productPane">${productPaneHTML(fam, selId)}</div>`;
  }

  const p = byId[id];
  if (!p) {
    return `<div class="wrap" style="padding:80px 0;text-align:center;"><h1>Product not found</h1><p class="muted" style="margin-top:12px;"><a href="#/shop" class="btn-ghost">← Back to shop</a></p></div>`;
  }
  const c = catInfo(p.category);
  const specRows = ["Appearance", "Storage", "Purity"]
    .filter((k) => p.specifications[k])
    .map((k) => `<div class="spec-row"><dt>${esc(k)}</dt><dd>${esc(p.specifications[k])}</dd></div>`)
    .join("");
  const related = SHOP_ITEMS.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 4);

  return `
  <div class="page-hero"><div class="wrap">
    <div class="breadcrumb"><a href="#/">Home</a> / <a href="#/shop">Shop</a> / <a href="#/shop?cat=${c.id}">${c.name}</a> / ${esc(p.name)}</div>
  </div></div>
  <section>
    <div class="wrap">
      <div class="pd-grid">
        <div class="pd-media"><img src="${p.image}" alt="${esc(p.name)}"></div>
        <div class="pd-info">
          <span class="purity-pill"><span class="dot"></span>${p.specifications.Purity || "≥99%"} HPLC</span>
          <h1>${esc(p.name)}</h1>
          <div class="pd-sku">SKU ${esc(p.sku)} · ${esc(p.concentration)} · ${esc(p.tagline)}</div>
          <p class="pd-desc">${esc(p.description)}</p>
          ${currentTier().badge ? `<span class="tier-badge">${esc(currentTier().badge)}</span>` : ""}
          <div class="pd-price-block"><span class="price">${fmt(tierPrice(p))}</span></div>
          ${tierMOQ() > 1 ? `<div class="pd-moq">Minimum order: ${tierMOQ()} units</div>` : ""}
          <div class="pd-buy-row">
            <button class="btn btn-primary" data-buy="${p.id}">Add to Cart</button>
          </div>
          ${p.brochure ? `<a class="btn btn-secondary pd-brochure-btn" href="${p.brochure}" target="_blank" rel="noopener">${ICONS.download}Download Brochure</a>` : ""}
          <dl class="spec-table">${specRows}</dl>
        </div>
      </div>
    </div>
  </section>
  ${
    related.length
      ? `<section class="panel-bg"><div class="wrap"><div class="section-head"><h2>Related in ${c.name}</h2></div><div class="product-grid">${related
          .map((r, i) => productCard(r, i))
          .join("")}</div></div></section>`
      : ""
  }`;
}

const GALLERY_PHOTOS = [
  { src: "/images/gallery/gallery-09.jpg", caption: "BAC Water vials queued for labeling" },
  { src: "/images/gallery/gallery-05.jpg", caption: "BAC Water vials moving through the automated filling line" },
  { src: "/images/gallery/gallery-01.jpg", caption: "Tesamorelin/Ipamorelin Blend vial on the production floor" },
  { src: "/images/gallery/gallery-02.jpg", caption: "Epithalon 50mg vials, freshly labeled" },
  { src: "/images/gallery/gallery-03.jpg", caption: "CJC-1295/Ipamorelin vials staged for quality review" },
  { src: "/images/gallery/gallery-04.jpg", caption: "GHK-Cu/TB-500/BPC-157/KPV \"GLOW\" and \"KLOW\" vials on the line" },
  { src: "/images/gallery/gallery-06.jpg", caption: "Our CEO and MD with a finished batch on the production floor" },
  { src: "/images/gallery/gallery-07.jpg", caption: "BAC Water vials passing through automated capping" },
  { src: "/images/gallery/gallery-08.jpg", caption: "GHK-Cu/BPC-157/TB-500 \"GLOW\" and \"KLOW\" vials, stacked for review" },
  { src: "/images/gallery/gallery-10.jpg", caption: "Quality check on a GHK-Cu/TB-500/BPC-157/KPV \"KLOW\" vial fresh off the line" },
  { src: "/images/gallery/gallery-11.jpg", caption: "GLOW blend, GLP-3 RT, and Tesamorelin/Ipamorelin Blend vials, side by side" },
];

function viewGallery() {
  const tiles = GALLERY_PHOTOS.map(
    (p, i) => `
    <button type="button" class="gallery-tile" data-gallery-index="${i}">
      <img src="${p.src}" alt="${esc(p.caption)}" loading="lazy">
    </button>`
  ).join("");
  return `
  <div class="page-hero info-hero bold-hero"><div class="wrap">
    <span class="eyebrow">Behind the Scenes</span>
    <h1>Gallery</h1>
    <p class="lede">A look at our manufacturing facility, our team, and the research compounds we produce.</p>
  </div></div>
  <section><div class="wrap">
    <div class="gallery-grid">${tiles}</div>
  </div></section>
  <div class="gallery-lightbox" id="galleryLightbox" hidden>
    <button type="button" class="gallery-lightbox-close" id="galleryClose" aria-label="Close">${ICONS.close || "&times;"}</button>
    <button type="button" class="gallery-lightbox-nav gallery-lightbox-prev" id="galleryPrev" aria-label="Previous photo">&#8249;</button>
    <img class="gallery-lightbox-img" id="galleryLightboxImg" src="" alt="">
    <button type="button" class="gallery-lightbox-nav gallery-lightbox-next" id="galleryNext" aria-label="Next photo">&#8250;</button>
    <p class="gallery-lightbox-caption" id="galleryLightboxCaption"></p>
  </div>`;
}

function wireGalleryPage() {
  const grid = document.querySelector(".gallery-grid");
  const lightbox = document.getElementById("galleryLightbox");
  if (!grid || !lightbox) return;

  const img = document.getElementById("galleryLightboxImg");
  const caption = document.getElementById("galleryLightboxCaption");
  let current = 0;

  function show(i) {
    current = (i + GALLERY_PHOTOS.length) % GALLERY_PHOTOS.length;
    const p = GALLERY_PHOTOS[current];
    img.src = p.src;
    img.alt = p.caption;
    caption.textContent = p.caption;
  }
  function open(i) {
    show(i);
    lightbox.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function close() {
    lightbox.hidden = true;
    document.body.style.overflow = "";
  }

  grid.querySelectorAll("[data-gallery-index]").forEach((btn) => {
    btn.addEventListener("click", () => open(Number(btn.getAttribute("data-gallery-index"))));
  });
  const closeBtn = document.getElementById("galleryClose");
  const prevBtn = document.getElementById("galleryPrev");
  const nextBtn = document.getElementById("galleryNext");
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (prevBtn) prevBtn.addEventListener("click", () => show(current - 1));
  if (nextBtn) nextBtn.addEventListener("click", () => show(current + 1));
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) close(); });
  document.addEventListener("keydown", function onKey(e) {
    if (lightbox.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(current - 1);
    else if (e.key === "ArrowRight") show(current + 1);
  });
}

function viewAbout() {
  return `
  <section class="about-story">
    <div class="wrap">
      <div class="about-story-head">
        <span class="eyebrow">Our Story</span>
        <h1>Compounds you can verify, not just trust.</h1>
        <p class="lede">HoopBioPharma exists to give researchers compounds they can trust. Every product in our catalog ships at ≥99% purity, verified through independent HPLC analysis, with cold-chain handling from our facility to your bench.</p>
      </div>
      <div class="about-stats">
        <div class="about-stat"><b>≥99%</b><span>Lowest purity result published</span></div>
        <div class="about-stat"><b>${PRODUCTS.length}+</b><span>Research compounds</span></div>
        <div class="about-stat"><b>${CATEGORIES.length}</b><span>Research categories</span></div>
        <div class="about-stat"><b>48h</b><span>Cold-chain dispatch</span></div>
      </div>
      <div class="about-split">
        <div class="about-split-media"><img src="/images/about-lab.jpg" alt="HoopBioPharma independent testing laboratory" loading="lazy"></div>
        <div class="about-split-copy">
          <h2>Why we started</h2>
          <p>The research-peptide market is full of vague sourcing and unverified claims. We started HoopBioPharma to do the opposite — publish real purity data on every product, maintain strict cold-chain handling from synthesis to delivery, and treat the batch itself as the product, not the marketing around it.</p>
        </div>
      </div>
    </div>
  </section>
  <section class="about-grid-section">
    <div class="wrap">
      <div class="about-grid">
        <div class="about-grid-cell panel">
          <h2>How we work</h2>
          <p>Every compound we produce moves through the same disciplined pipeline: synthesis, purification, and lyophilization in a controlled facility, followed by independent third-party verification before a single vial is released for sale. We test for purity using HPLC and confirm identity with mass spectrometry, and we publish the resulting data on every product page instead of holding it back behind a certificate request form.</p>
          <p>Each batch is assigned its own lot number, so the results you see match the vial in your hand — not a generic average across production runs. Vials are lyophilized for stability, packed cold-chain, and dispatched within 48 hours of your order, with tracking provided the moment your package ships. If a batch doesn't meet our purity threshold, it doesn't reach the catalog.</p>
        </div>
        <div class="about-grid-cell media no-crop"><img src="/images/about-corridor.jpg" alt="HoopBioPharma cold-chain dispatch corridor" loading="lazy"></div>
        <div class="about-grid-cell media"><img src="/images/about-kpv.jpg" alt="Researcher preparing a HoopBioPharma KPV vial" loading="lazy"></div>
        <div class="about-grid-cell panel">
          <h2>Who we serve</h2>
          <p>HoopBioPharma supplies laboratories, universities, and independent researchers. Everything in our catalog is strictly for laboratory research use only — never for human or animal consumption.</p>
        </div>
      </div>
      <div class="about-cta"><a href="#/shop" class="btn btn-primary">Shop the Catalog</a></div>
    </div>
  </section>`;
}

/* =========================================================
   WHOLESALE
   B2B page for labs, clinics, and distribution partners.
   No payment or account backend is wired up yet, so the inquiry
   form below hands off to a mailto: link addressed to the team,
   matching the pattern used at checkout.
   ========================================================= */
function viewWholesale() {
  return `
  <div class="page-hero info-hero bold-hero"><div class="wrap">
    <span class="eyebrow">B2B Wholesale</span>
    <h1>Wholesale pricing for labs, clinics, and distributors</h1>
    <p class="lede">Tiered pricing, cold-chain fulfillment, and published batch data — for labs, clinics, and distribution partners.</p>
    <div style="display:flex; gap:14px; justify-content:center; flex-wrap:wrap; margin-top:26px;">
      <button type="button" id="wholesaleScrollBtn" class="btn btn-primary">Start Wholesale Inquiry</button>
      <a href="#/coa" class="btn btn-outline">View Certificates of Analysis</a>
    </div>
  </div></div>

  <section style="padding-bottom:0;"><div class="wrap">
    <div class="about-stats" style="margin-top:0;">
      <div class="about-stat"><b>25+</b><span>Units per SKU to unlock wholesale tiers</span></div>
      <div class="about-stat"><b>48h</b><span>Cold-chain dispatch on wholesale orders</span></div>
      <div class="about-stat"><b>${PRODUCTS.length}+</b><span>Compounds available at wholesale</span></div>
      <div class="about-stat"><b>1–2 days</b><span>Typical inquiry response time</span></div>
    </div>
  </div></section>

  <section><div class="wrap">
    <div class="wholesale-cards">
      <div class="verify-card">
        <span class="verify-card-icon">${ICONS.tag}</span>
        <span class="verify-card-label">Tiered Volume Pricing</span>
        <p>Unit pricing steps down as your order size grows, starting at 25+ units per SKU and confirmed once onboarding is complete.</p>
        <ul class="verify-card-list">
          <li>Volume breaks from 25+ units per SKU</li>
          <li>Rates set with your account contact</li>
          <li>Reviewed case-by-case after approval</li>
        </ul>
      </div>
      <div class="verify-card">
        <span class="verify-card-icon">${ICONS.shipping}</span>
        <span class="verify-card-label">Cold-Chain Fulfillment</span>
        <p>Wholesale orders ship from the same temperature-controlled facility as our retail catalog.</p>
        <ul class="verify-card-list">
          <li>Temperature-controlled storage</li>
          <li>Same-day packing</li>
          <li>Dispatched within 48 hours</li>
        </ul>
      </div>
      <div class="verify-card">
        <span class="verify-card-icon">${ICONS.nfc}</span>
        <span class="verify-card-label">NFC &amp; QR Verification</span>
        <p>Optional NFC cap chips and printed QR codes let your customers confirm a vial against its published batch record.</p>
        <ul class="verify-card-list">
          <li>Anti-counterfeit cap chips</li>
          <li>Instant browser verification</li>
          <li>Per-vial batch traceability</li>
        </ul>
      </div>
      <div class="verify-card">
        <span class="verify-card-icon">${ICONS.testing}</span>
        <span class="verify-card-label">Batch-Level Certificates</span>
        <p>Every lot ships with independent HPLC and mass spectrometry results, searchable by product, SKU, or lot number.</p>
        <ul class="verify-card-list">
          <li>Independent HPLC &amp; MS data</li>
          <li>Searchable by SKU or lot</li>
          <li>Published for every batch</li>
        </ul>
        <a href="#/coa" class="verify-card-link">View Certificate Library ${ICONS.arrowRight}</a>
      </div>
      <div class="verify-card">
        <span class="verify-card-icon">${ICONS.clock}</span>
        <span class="verify-card-label">Dedicated Account Support</span>
        <p>Approved partners get a direct line to our team for reorders and questions about upcoming compounds.</p>
        <ul class="verify-card-list">
          <li>Direct line to our team</li>
          <li>Custom shipping cadences</li>
          <li>Early notice on new compounds</li>
        </ul>
      </div>
      <div class="verify-card">
        <span class="verify-card-icon">${ICONS.lock}</span>
        <span class="verify-card-label">Standing Documentation</span>
        <p>Research-use-only agreements and compliance paperwork are handled once, not re-requested on every order.</p>
        <ul class="verify-card-list">
          <li>Research-use-only agreements</li>
          <li>Handled once at onboarding</li>
          <li>Never re-requested per order</li>
        </ul>
      </div>
    </div>
  </div></section>

  <section id="wholesaleForm"><div class="wrap">
    <div class="wsapp-head">
      <span class="eyebrow">Wholesale Application</span>
      <h2>Apply for partner access</h2>
      <p class="lede">Five short steps, about two minutes. There's no cost to apply, and our team reviews every application within 1–2 business days.</p>
    </div>
    <div class="wsapp-card">
      <div class="wsapp-progress">
        <div class="wsapp-progress-row">
          <span class="wsapp-progress-label" id="wsappStepLabel">Step 1 of 5</span>
          <span class="wsapp-progress-pct mono" id="wsappStepPct">20%</span>
        </div>
        <div class="wsapp-progress-track"><div class="wsapp-progress-fill" id="wsappProgressFill" style="width:20%"></div></div>
      </div>
      <form id="wholesaleAppForm" novalidate>
        <div class="wsapp-step" data-step="1">
          <h3>Business Contact</h3>
          <div class="auth-field"><label for="wsBusiness">Business name</label><input type="text" id="wsBusiness" placeholder="Business name" required></div>
          <div class="auth-field"><label for="wsContactName">Your name</label><input type="text" id="wsContactName" placeholder="Your name" required></div>
          <div class="auth-field"><label for="wsEmail">Business email</label><input type="email" id="wsEmail" placeholder="Business email" required></div>
          <div class="co-field-row">
            <div class="auth-field"><label for="wsPhone">Phone number</label><input type="tel" id="wsPhone" placeholder="Phone number" required></div>
            <div class="auth-field"><label for="wsWebsite">Website (optional)</label><input type="text" id="wsWebsite" placeholder="Website (optional)"></div>
          </div>
        </div>
        <div class="wsapp-step" data-step="2" hidden>
          <h3>Organization Details</h3>
          <div class="auth-field"><label for="wsType">Organization type</label>
            <select id="wsType" required>
              <option value="" disabled selected>Select organization type</option>
              <option>Research Lab</option>
              <option>Clinic</option>
              <option>Distributor</option>
              <option>University</option>
              <option>Other</option>
            </select>
          </div>
          <div class="auth-field"><label for="wsVolume">Estimated monthly volume</label><input type="text" id="wsVolume" placeholder="e.g. 50 units/month" required></div>
        </div>
        <div class="wsapp-step" data-step="3" hidden>
          <h3>Shipping Address</h3>
          <div class="auth-field"><label for="wsAddress">Street address</label><input type="text" id="wsAddress" placeholder="Street address" required></div>
          <div class="co-field-row">
            <div class="auth-field"><label for="wsCity">City</label><input type="text" id="wsCity" placeholder="City" required></div>
            <div class="auth-field"><label for="wsState">State / Province</label><input type="text" id="wsState" placeholder="State / Province" required></div>
          </div>
          <div class="co-field-row">
            <div class="auth-field"><label for="wsZip">Postal code</label><input type="text" id="wsZip" placeholder="Postal code" required></div>
            <div class="auth-field"><label for="wsCountry">Country</label><input type="text" id="wsCountry" placeholder="Country" value="United States" required></div>
          </div>
        </div>
        <div class="wsapp-step" data-step="4" hidden>
          <h3>Compliance</h3>
          <label class="wsapp-check"><input type="checkbox" id="wsComplianceUse" required><span>This application is for laboratory research use only — not for human or animal consumption.</span></label>
          <label class="wsapp-check"><input type="checkbox" id="wsComplianceAuth" required><span>I confirm I'm at least 21 years old and authorized to order on behalf of this organization.</span></label>
        </div>
        <div class="wsapp-step" data-step="5" hidden>
          <h3>Review &amp; Submit</h3>
          <p class="muted" style="font-size:13.5px; margin-bottom:16px;">Check your details, then submit — this opens an email addressed to our wholesale team with everything below.</p>
          <div class="wsapp-review" id="wsappReview"></div>
        </div>
        <div class="wsapp-nav">
          <button type="button" class="btn btn-ghost" id="wsappBack" hidden>Back</button>
          <button type="button" class="btn btn-primary" id="wsappNext" disabled>Next</button>
        </div>
      </form>
    </div>
  </div></section>`;
}

/* =========================================================
   TERMS AND CONDITIONS
   ========================================================= */
function viewTerms() {
  return `
  <div class="page-hero info-hero"><div class="wrap">
    <span class="eyebrow">Legal</span>
    <h1>Terms and Conditions</h1>
  </div></div>
  <section><div class="wrap">
    <div class="legal-content">
      <p class="legal-updated">Last updated: September 6, 2026</p>

      <h2>1. Acceptance of Terms</h2>
      <p>By accessing this site or placing an order through HoopBioPharma ("we," "our," or "us"), you agree to these Terms and Conditions. If you do not agree with any part of them, please do not use the site or place an order. We may revise these Terms at any time — the version posted here is always the current one, and continuing to use the site after a change means you accept it.</p>

      <h2>2. Product Information</h2>
      <p>Every product listed on this site is intended strictly for laboratory research use only — not for human or animal consumption, and not for diagnostic or in vitro diagnostic use. We make every effort to keep descriptions, purity data, and pricing accurate and current, but we don't warrant that any listing is free of error. A Certificate of Analysis reflects the specific batch it was issued for; independent verification of any compound remains the purchaser's responsibility.</p>

      <h2>3. Orders &amp; Payment</h2>
      <p>All orders are subject to acceptance and product availability. Placing an order does not guarantee fulfillment — we reserve the right to refuse or cancel any order at our discretion, including for suspected misuse, pricing errors, or failure to meet our research-use eligibility requirements. Wholesale orders are billed according to the terms agreed with your account contact during onboarding.</p>

      <h2>4. Shipping &amp; Delivery</h2>
      <p>Shipping options, fees, and estimated delivery times are shown at checkout. Orders are packed cold-chain and typically dispatched within 48 hours of confirmation. Risk of loss passes to you once an order is handed to the carrier, and we aren't responsible for delays caused by carriers or events outside our reasonable control.</p>

      <h2>5. Returns &amp; Refunds</h2>
      <p>Given the nature of our products, we generally can't accept returns once an order has shipped. If your order arrives damaged, incorrect, or incomplete, contact us within 7 days of delivery at <a href="mailto:Info@hoopbiopharma.com">Info@hoopbiopharma.com</a> and we'll make it right.</p>

      <h2>6. Limitation of Liability</h2>
      <p>To the maximum extent permitted by law, HoopBioPharma and its officers, employees, and affiliates are not liable for any indirect, incidental, special, or consequential damages arising from your use of this site or purchase of our products. Our total liability for any claim is limited to the amount you paid for the product giving rise to it.</p>

      <h2>7. Intellectual Property</h2>
      <p>All content on this site — including text, product photography, graphics, and the HoopBioPharma name and logo — belongs to HoopBioPharma or its licensors. You may not copy, reproduce, or redistribute any of it without our written permission.</p>

      <h2>8. Governing Law</h2>
      <p>These Terms are governed by the laws of the jurisdiction in which HoopBioPharma operates, without regard to conflict-of-law principles.</p>

      <h2>9. Changes to Terms</h2>
      <p>We may revise these Terms at any time. Updates take effect as soon as they're posted to this page, and the "Last updated" date above reflects the most recent revision.</p>

      <h2>10. Contact Us</h2>
      <p>Questions about these Terms? Email us at <a href="mailto:Info@hoopbiopharma.com">Info@hoopbiopharma.com</a> and our team will get back to you.</p>
    </div>
  </div></section>`;
}

function viewResearchUseOnly() {
  return `
  <div class="page-hero info-hero"><div class="wrap">
    <span class="eyebrow">Legal</span>
    <h1>Research Use Only</h1>
  </div></div>
  <section><div class="wrap">
    <div class="legal-content">
      <p class="legal-updated">Last updated: September 6, 2026</p>

      <h2>Intended Use</h2>
      <p>Every compound sold by HoopBioPharma is manufactured and distributed strictly for laboratory research use. Our products are not drugs, dietary supplements, cosmetics, or foods, and they are not intended to diagnose, treat, cure, mitigate, or prevent any disease or condition in humans or animals. They are supplied to qualified researchers, laboratories, and institutions for in vitro study, analytical work, and other non-clinical research purposes only.</p>

      <h2>Your Responsibilities</h2>
      <p>By purchasing from HoopBioPharma, you confirm that you are at least 21 years of age and that you accept the following conditions of sale:</p>
      <ul>
        <li>You will use any product purchased solely for laboratory or research purposes.</li>
        <li>You will not administer, ingest, inject, or otherwise introduce any product into a human or animal body.</li>
        <li>You will not resell, repackage, or represent any product as suitable for human or animal consumption, clinical use, or personal use of any kind.</li>
        <li>You have the training, facilities, and authority necessary to handle research compounds safely and in compliance with applicable laws.</li>
        <li>You are solely responsible for how a product is stored, handled, and disposed of once it leaves our custody.</li>
      </ul>

      <h2>FDA Disclaimer</h2>
      <p>Products sold by HoopBioPharma have not been evaluated or approved by the U.S. Food and Drug Administration or any equivalent regulatory body. No statement on this site has been evaluated by the FDA, and nothing here should be read as medical or health advice. These products are not for sale to the general public for human use and are exempt from standard pharmaceutical labeling requirements because they are sold exclusively as research chemicals.</p>

      <h2>Product Documentation</h2>
      <p>Each batch we release is tested by an independent laboratory using HPLC and mass spectrometry, and the resulting Certificate of Analysis is published in our <a href="#/coa">certificate library</a>. Every vial ships with an NFC and QR verification tag so its batch documentation can be confirmed on arrival. If you can't locate a certificate for a batch you've received, contact us and we'll provide it directly.</p>

      <p>Questions about research-use eligibility or documentation? Email us at <a href="mailto:Info@hoopbiopharma.com">Info@hoopbiopharma.com</a> and our team will get back to you.</p>
    </div>
  </div></section>`;
}

function viewContact() {
  return `
  <div class="page-hero info-hero bold-hero"><div class="wrap">
    <span class="eyebrow">${ICONS.chat} Support</span>
    <h1>Contact Us</h1>
    <p class="lede">Questions about an order, a product, or wholesale onboarding — our team typically replies within one to two business days.</p>
  </div></div>
  <section><div class="wrap">
    <div class="contact-grid">
      <div class="contact-col">
        <div class="contact-card">
          <h3>Direct Line</h3>
          <div class="contact-direct-row">
            <span class="feature-icon">${ICONS.mail}</span>
            <div>
              <div class="contact-direct-label">Email</div>
              <div class="contact-direct-value"><a href="mailto:Info@hoopbiopharma.com">Info@hoopbiopharma.com</a></div>
            </div>
          </div>
          <div class="contact-direct-row">
            <span class="feature-icon">${ICONS.clock}</span>
            <div>
              <div class="contact-direct-label">Hours</div>
              <div class="contact-direct-value">Monday – Friday, 9 AM – 6 PM EST</div>
            </div>
          </div>
        </div>
        <div class="contact-card">
          <h3>Quick Paths</h3>
          <div class="contact-quicklinks">
            <a href="#/wholesale" class="contact-quick-link">
              <span class="q-label">Wholesale pricing (25+ units)</span>
              ${ICONS.arrowRight}
            </a>
            <a href="#/coa" class="contact-quick-link">
              <span class="q-label">Certificate library &amp; batch lookup</span>
              ${ICONS.arrowRight}
            </a>
            <a href="#/shop" class="contact-quick-link">
              <span class="q-label">Browse the full catalog</span>
              ${ICONS.arrowRight}
            </a>
          </div>
        </div>
        <p class="contact-note">Include your order number for the fastest response. All products are sold for laboratory research use only — not for human or animal consumption.</p>
      </div>
      <div class="contact-form-card">
        <span class="eyebrow">Get In Touch</span>
        <h2>How can we help?</h2>
        <form id="contactForm">
          <div class="co-field-row">
            <div class="auth-field"><label for="ctName">Name</label><input type="text" id="ctName" placeholder="Your name" required></div>
            <div class="auth-field"><label for="ctEmail">Email</label><input type="email" id="ctEmail" placeholder="you@company.com" required></div>
          </div>
          <div class="co-field-row">
            <div class="auth-field"><label for="ctCompany">Company (optional)</label><input type="text" id="ctCompany" placeholder="Organization"></div>
            <div class="auth-field"><label for="ctPhone">Phone (optional)</label><input type="tel" id="ctPhone" placeholder="+1 (555) 000-0000"></div>
          </div>
          <div class="auth-field">
            <label for="ctTopic">Topic</label>
            <select id="ctTopic">
              <option>General inquiry</option>
              <option>Order status</option>
              <option>Product question</option>
              <option>Wholesale &amp; partnerships</option>
              <option>Certificate request</option>
              <option>Other</option>
            </select>
          </div>
          <div class="auth-field">
            <label for="ctMessage">Message</label>
            <textarea id="ctMessage" placeholder="Tell us what you need — order numbers, SKUs, or batch numbers help us respond faster." required></textarea>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%; margin-top:22px;">Send Message ${ICONS.arrowRight}</button>
        </form>
      </div>
    </div>
  </div></section>`;
}

/* =========================================================
   PEPTIDE INFORMATION PAGES
   ========================================================= */

/* ---- Certificates of Analysis (COA) library ----
   COA_AVAILABLE maps a product id to its certificate PDF path. Nothing
   is filled in yet — to publish a real certificate, drop the PDF into
   public/coas/ and add a line here, e.g.:
     "bpc157-10mg": "/coas/bpc157-10mg.pdf"
   Any product id left out shows a "Pending upload" state instead of a
   broken or placeholder link. */
const COA_AVAILABLE = {};

function coaRowsHTML(query) {
  const q = (query || "").trim().toLowerCase();
  const rows = PRODUCTS.filter((p) => {
    if (!q) return true;
    const cat = catInfo(p.category);
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (cat && cat.name.toLowerCase().includes(q));
  });
  if (!rows.length) {
    return `<div class="coa-empty">No products match "${esc(query)}".</div>`;
  }
  return rows.map((p) => {
    const cat = catInfo(p.category);
    const file = COA_AVAILABLE[p.id];
    const action = file
      ? `<a href="${esc(file)}" target="_blank" rel="noopener" class="coa-view-btn">View COA ${ICONS.arrowRight}</a>`
      : `<span class="coa-pending">Pending upload</span>`;
    return `
    <div class="coa-row">
      <div class="coa-row-main">
        <a href="#/shop/${p.id}" class="coa-row-name">${esc(p.name)}</a>
        <div class="coa-row-meta mono">${esc(p.sku)} · ${esc(cat ? cat.name : "")}</div>
      </div>
      <span class="coa-purity mono">${esc(p.specifications.Purity || "≥99%")} HPLC</span>
      ${action}
    </div>`;
  }).join("");
}

function viewCOA() {
  return `
  <div class="page-hero info-hero"><div class="wrap">
    <span class="eyebrow">Peptide Information</span>
    <h1>Certificates of Analysis</h1>
    <p class="lede">Every batch we sell is verified by independent HPLC testing. Search our certificate library by product name, SKU, or category.</p>
    <div class="coa-search">
      <span aria-hidden="true">${ICONS.search}</span>
      <input type="text" id="coaSearchInput" placeholder="Search by product, SKU, or category…" aria-label="Search certificates of analysis">
    </div>
  </div></div>
  <section><div class="wrap">
    <div class="coa-list" id="coaList">${coaRowsHTML("")}</div>
  </div></section>`;
}

/* =========================================================
   CHECKOUT
   Step 1 collects shipping details + promo code client-side for the
   order summary. Step 2 hands the cart off to
   /api/create-checkout-session, which re-validates every price and
   the promo code server-side against src/data/ (never trusts the
   client), creates a Stripe Checkout Session, and the browser is
   redirected to Stripe's hosted payment page.
   ========================================================= */
function checkoutLinesHTML() {
  return cart.map((l) => {
    const p = byId[l.id];
    if (!p) return "";
    const unit = tierPrice(p);
    return `<div class="co-summary-line">
      <span>${esc(p.name)} × ${l.qty}</span>
      <span>${fmt(unit * l.qty)}</span>
    </div>`;
  }).join("");
}

function viewOrderConfirmation(query) {
  const ok = !!(query && query.session_id);
  if (ok) { cart = []; persistCart(); renderCartCount(); }
  return `
  <div class="page-hero info-hero"><div class="wrap">
    <h1>${ok ? "Thank you — your order is in!" : "Checkout session not found"}</h1>
    <p class="lede">${ok
      ? "Payment was received. A confirmation is on its way to your email, and our team will follow up with tracking once your order ships."
      : "We couldn't confirm that payment session. If you completed a payment, check your email for a Stripe receipt, or contact Info@hoopbiopharma.com."}</p>
    <a href="#/shop" class="btn btn-primary" style="margin-top:22px;">Continue shopping</a>
  </div></div>`;
}

function viewCheckout() {
  if (cart.length === 0) {
    return `
    <div class="page-hero info-hero"><div class="wrap">
      <h1>Your cart is empty</h1>
      <p class="lede">Add research compounds from the Shop before checking out.</p>
      <a href="#/shop" class="btn btn-primary" style="margin-top:22px;">Browse the Shop</a>
    </div></div>`;
  }
  return `
  <section class="checkout-section"><div class="wrap">
    <div class="checkout-steps" id="checkoutSteps">
      <span class="co-step-label active" data-step-label="1"><span class="co-step-num">1</span>Shipping</span>
      <span class="co-step-line"></span>
      <span class="co-step-label" data-step-label="2"><span class="co-step-num">2</span>Review &amp; Payment</span>
    </div>
    <div class="checkout-grid">
      <div class="checkout-main">
        <div class="co-panel" data-co-panel="1">
          <h3>Shipping details</h3>
          <div class="co-field-row">
            <div class="auth-field"><label for="coName">Full name</label><input type="text" id="coName" placeholder="Full name" required></div>
            <div class="auth-field"><label for="coPhone">Phone</label><input type="tel" id="coPhone" placeholder="Phone number" required></div>
          </div>
          <div class="auth-field"><label for="coAddress">Street address</label><input type="text" id="coAddress" placeholder="Street address" required></div>
          <div class="co-field-row">
            <div class="auth-field"><label for="coCity">City</label><input type="text" id="coCity" placeholder="City" required></div>
            <div class="auth-field"><label for="coState">State / Province</label><input type="text" id="coState" placeholder="State / Province" required></div>
          </div>
          <div class="co-field-row">
            <div class="auth-field"><label for="coZip">Postal code</label><input type="text" id="coZip" placeholder="Postal code" required></div>
            <div class="auth-field"><label for="coCountry">Country</label><input type="text" id="coCountry" placeholder="Country" value="United States" required></div>
          </div>
          <div class="co-divider-label"><span>Shipping method</span></div>
          <div class="co-ship-options">
            <label class="co-ship-option is-checked">
              <input type="radio" name="coShipMethod" value="priority" checked>
              <span class="co-ship-radio"></span>
              <span class="co-ship-info">
                <span class="co-ship-name">Priority Shipping</span>
                <span class="co-ship-sub">2–3 business days</span>
              </span>
              <span class="co-ship-price">$14.00</span>
            </label>
            <label class="co-ship-option">
              <input type="radio" name="coShipMethod" value="overnight">
              <span class="co-ship-radio"></span>
              <span class="co-ship-info">
                <span class="co-ship-name">Overnight Shipping</span>
                <span class="co-ship-sub">Next business day</span>
              </span>
              <span class="co-ship-price">$50.00</span>
            </label>
          </div>
          <div class="co-divider-label"><span>Promo code</span></div>
          <div class="co-promo-row">
            <div class="auth-field"><label for="coPromo">Promo code</label><input type="text" id="coPromo" placeholder="Enter code" autocomplete="off"></div>
            <button type="button" class="btn btn-ghost co-promo-btn" id="coPromoApply">Apply</button>
          </div>
          <p class="co-promo-msg" id="coPromoMsg" hidden></p>
          <div class="co-actions co-actions-end"><button type="button" class="btn btn-primary" id="coStep1Next">Continue to Review</button></div>
        </div>
        <div class="co-panel" data-co-panel="2" hidden>
          <h3>Review &amp; payment</h3>
          <div class="co-actions co-actions-end"><button type="button" class="btn btn-ghost" id="coStep2Back">Back</button></div>
          <div id="stripeCheckoutMount" class="stripe-embedded-mount"></div>
        </div>
      </div>
      <aside class="checkout-summary">
        <h4>Order summary</h4>
        <div class="co-summary-lines">${checkoutLinesHTML()}</div>
        <div class="co-summary-row"><span>Subtotal</span><span>${fmt(cartSubtotal())}</span></div>
        <div class="co-summary-row co-summary-row-discount" id="coPromoRow" hidden><span>Promo (<span id="coPromoCodeLabel"></span>)</span><span id="coPromoAmount"></span></div>
        <div class="co-summary-row"><span>Shipping</span><span id="coShipCostDisplay">$14.00</span></div>
        <div class="co-summary-subtotal"><span>Total</span><span id="coGrandTotal">${fmt(cartSubtotal() + 14)}</span></div>
        <div class="co-summary-note">Taxes confirmed before payment</div>
        <a href="#/shop" class="co-edit-cart">Edit cart</a>
      </aside>
    </div>
  </div></section>`;
}

function wireCheckoutPage() {
  const steps = document.getElementById("checkoutSteps");
  if (!steps) return;

  function goToStep(n) {
    document.querySelectorAll("[data-co-panel]").forEach((el) => {
      el.hidden = el.getAttribute("data-co-panel") !== String(n);
    });
    document.querySelectorAll("[data-step-label]").forEach((el) => {
      const s = Number(el.getAttribute("data-step-label"));
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }
  function validStep1() {
    return val("coName") && val("coPhone") && val("coAddress") && val("coCity") && val("coState") && val("coZip") && val("coCountry");
  }

  function selectedShipKey() {
    const el = document.querySelector('input[name="coShipMethod"]:checked');
    return el && SHIP_METHODS[el.value] ? el.value : "priority";
  }

  // Promo codes are checked against the PROMO_CODES list defined near the
  // top of this file — no database involved. Flat percentage off the
  // product subtotal only (shipping is never discounted). Case-insensitive
  // on entry.
  let appliedPromo = null; // { code, pct } once a valid code is applied

  function promoDiscount() {
    if (!appliedPromo) return 0;
    return money(cartSubtotal() * appliedPromo.pct);
  }

  function updateShipSummary() {
    const key = selectedShipKey();
    const price = SHIP_METHODS[key].price;
    document.querySelectorAll(".co-ship-option").forEach((opt) => {
      const input = opt.querySelector('input[name="coShipMethod"]');
      opt.classList.toggle("is-checked", !!input && input.checked);
    });
    const discount = promoDiscount();
    const promoRow = document.getElementById("coPromoRow");
    const promoAmountEl = document.getElementById("coPromoAmount");
    const promoCodeLabel = document.getElementById("coPromoCodeLabel");
    if (appliedPromo && discount > 0) {
      if (promoRow) promoRow.hidden = false;
      if (promoAmountEl) promoAmountEl.textContent = `-${fmt(discount)}`;
      if (promoCodeLabel) promoCodeLabel.textContent = appliedPromo.code;
    } else if (promoRow) {
      promoRow.hidden = true;
    }
    const shipEl = document.getElementById("coShipCostDisplay");
    const totalEl = document.getElementById("coGrandTotal");
    if (shipEl) shipEl.textContent = fmt(price);
    if (totalEl) totalEl.textContent = fmt(cartSubtotal() + price - discount);
  }
  document.querySelectorAll('input[name="coShipMethod"]').forEach((r) => {
    r.addEventListener("change", updateShipSummary);
  });

  const promoInput = document.getElementById("coPromo");
  const promoApplyBtn = document.getElementById("coPromoApply");
  const promoMsg = document.getElementById("coPromoMsg");
  function showPromoMsg(text, isError) {
    if (!promoMsg) return;
    promoMsg.textContent = text;
    promoMsg.className = `co-promo-msg ${isError ? "is-error" : "is-success"}`;
    promoMsg.hidden = false;
  }
  if (promoApplyBtn) promoApplyBtn.addEventListener("click", () => {
    const raw = promoInput ? promoInput.value.trim() : "";
    const code = raw.toUpperCase();
    if (!code) { showPromoMsg("Enter a promo code", true); return; }
    if (appliedPromo && appliedPromo.code === code) {
      showPromoMsg(`${code} already applied — ${Math.round(appliedPromo.pct * 100)}% off your subtotal`, false);
      return;
    }
    const pct = PROMO_CODES[code];
    if (pct == null) {
      appliedPromo = null;
      showPromoMsg("That code isn't valid or is inactive", true);
    } else {
      appliedPromo = { code, pct: Number(pct) };
      showPromoMsg(`${code} applied — ${Math.round(appliedPromo.pct * 100)}% off your subtotal`, false);
    }
    updateShipSummary();
  });
  if (promoInput) promoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); promoApplyBtn && promoApplyBtn.click(); }
  });

  updateShipSummary();

  // Embedded Stripe Checkout — mounted into #stripeCheckoutMount once the
  // shopper reaches step 2. Recreated (destroy + fetch a fresh session)
  // every time step 2 is (re-)entered, so a promo code or shipping method
  // changed after going Back is reflected in the mounted total.
  // embeddedCheckout/stripeClient are module-scoped (declared near `cart`
  // above) rather than local here, see the comment there.

  async function mountEmbeddedCheckout() {
    const mountEl = document.getElementById("stripeCheckoutMount");
    if (!mountEl) return;
    mountEl.innerHTML = '<div class="co-embed-loading">Loading secure payment…</div>';
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((l) => ({ id: l.id, qty: l.qty })),
          tierKey: currentTier().key,
          shipMethod: selectedShipKey(),
          promoCode: appliedPromo ? appliedPromo.code : null,
          customer: {
            name: val("coName"),
            phone: val("coPhone"),
            email: currentUser && currentUser.email ? currentUser.email : "",
            address: val("coAddress"),
            city: val("coCity"),
            state: val("coState"),
            zip: val("coZip"),
            country: val("coCountry")
          }
        })
      });
      const data = await res.json();
      if (!res.ok || !data.clientSecret) throw new Error(data.error || "Could not start checkout");
      if (embeddedCheckout) { embeddedCheckout.destroy(); embeddedCheckout = null; }
      if (!stripeClient) stripeClient = Stripe(data.publishableKey);
      mountEl.innerHTML = "";
      embeddedCheckout = await stripeClient.createEmbeddedCheckoutPage({
        fetchClientSecret: async () => data.clientSecret
      });
      embeddedCheckout.mount("#stripeCheckoutMount");
    } catch (err) {
      mountEl.innerHTML = `<p class="co-note co-embed-error">${esc(err.message || "Something went wrong starting checkout — please try again")}</p>`;
    }
  }

  const next1 = document.getElementById("coStep1Next");
  if (next1) next1.addEventListener("click", () => {
    if (!validStep1()) { showToast("Please fill in your name, phone, and full shipping address"); return; }
    goToStep(2);
    mountEmbeddedCheckout();
  });
  const back2 = document.getElementById("coStep2Back");
  if (back2) back2.addEventListener("click", () => {
    if (embeddedCheckout) { embeddedCheckout.destroy(); embeddedCheckout = null; }
    goToStep(1);
  });

  goToStep(1);
}

/* =========================================================
   ADMIN PORTAL
   Lets the admin account key in an order taken outside the site
   (phone, email, in person) and save it to the `orders` table in
   Supabase. Gated purely by ADMIN_EMAIL for the UI — the actual
   access control is Supabase Row Level Security on that table, set
   up once via a SQL script run in the Supabase dashboard (not part
   of this codebase), so even a bypassed UI check can't read or
   write orders as anyone else.
   ========================================================= */
const ADMIN_SHIP_METHODS = [
  { key: "priority", label: "Priority (2–3 business days)", price: 14 },
  { key: "overnight", label: "Overnight (next business day)", price: 50 }
];

// One admin-order line item's default unit price for a given price tier —
// mirrors tierPrice()'s logic but takes an explicit tier instead of
// reading the global customerType, since the admin picks a tier per order.
function adminPriceForTier(product, tierName) {
  const tier = CUSTOMER_TIERS[tierName] || CUSTOMER_TIERS["Retail Customer"];
  if (product.tierPricing && typeof product.tierPricing[tier.key] === "number") return product.tierPricing[tier.key];
  return money(product.price * tier.multiplier);
}

function adminDefaultLine() {
  const p = PRODUCTS[0];
  return { productId: p ? p.id : "", qty: 1, unitPrice: p ? adminPriceForTier(p, "Retail Customer") : 0 };
}
let adminLines = [adminDefaultLine()];
let adminRecentOrders = [];
let adminOrdersLoaded = false;

function adminProductOptionsHTML(selectedId) {
  return PRODUCTS.map(
    (p) => `<option value="${esc(p.id)}"${p.id === selectedId ? " selected" : ""}>${esc(p.name)} — ${esc(p.concentration)} (${esc(p.sku)})</option>`
  ).join("");
}

function adminLineRowHTML(line, idx) {
  return `
  <div class="admin-line-row" data-line-idx="${idx}">
    <select class="admin-line-product" data-admin-field="productId" data-idx="${idx}">${adminProductOptionsHTML(line.productId)}</select>
    <input type="number" min="1" step="1" class="admin-line-qty" data-admin-field="qty" data-idx="${idx}" value="${line.qty}" aria-label="Quantity">
    <div class="admin-line-price-wrap">
      <span>$</span>
      <input type="number" min="0" step="0.01" class="admin-line-price" data-admin-field="unitPrice" data-idx="${idx}" value="${line.unitPrice}" aria-label="Unit price">
    </div>
    <span class="admin-line-total mono">${fmt(line.qty * line.unitPrice)}</span>
    <button type="button" class="admin-line-remove" data-admin-remove="${idx}" aria-label="Remove item">${ICONS.close}</button>
  </div>`;
}

function adminLinesTotal() {
  return adminLines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
}

function adminShipCost() {
  const sel = document.getElementById("adminShipMethod");
  if (!sel) return 0;
  const method = ADMIN_SHIP_METHODS.find((m) => m.key === sel.value);
  return method ? method.price : 0;
}

function adminOrderRowHTML(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsSummary = items.map((it) => `${it.name} ×${it.qty}`).join(", ");
  const when = order.created_at ? new Date(order.created_at).toLocaleString() : "—";
  return `
  <div class="admin-order-row">
    <div class="admin-order-main">
      <span class="admin-order-customer">${esc(order.customer_name || "—")}</span>
      <span class="admin-order-items mono">${esc(itemsSummary || "no items")}</span>
    </div>
    <span class="admin-order-when mono">${esc(when)}</span>
    <span class="admin-order-total mono">${fmt(order.total || 0)}</span>
  </div>`;
}

function adminOrdersListHTML() {
  if (!adminOrdersLoaded) return `<p class="muted" style="padding:20px 0;">Loading recent orders…</p>`;
  if (!adminRecentOrders.length) return "";
  return adminRecentOrders.map(adminOrderRowHTML).join("");
}

function viewAdmin() {
  if (!isAdmin()) {
    return `
    <div class="wrap" style="padding:80px 0;text-align:center;">
      <h1>Admin access only</h1>
      <p class="muted" style="margin-top:12px;">Sign in with the admin account to reach this page.</p>
      <a href="#/" class="btn btn-outline" style="margin-top:22px;">← Back home</a>
    </div>`;
  }
  const tierOptions = Object.keys(CUSTOMER_TIERS)
    .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)
    .join("");
  const shipOptions = ADMIN_SHIP_METHODS.map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join("");

  return `
  <section><div class="wrap admin-grid">
    <div class="admin-panel">
      <h3>Customer</h3>
      <div class="co-field-row">
        <div class="auth-field"><label for="adminName">Full name</label><input type="text" id="adminName" placeholder="Full name" required></div>
        <div class="auth-field"><label for="adminPhone">Phone</label><input type="tel" id="adminPhone" placeholder="Phone number"></div>
      </div>
      <div class="auth-field"><label for="adminEmail">Email</label><input type="email" id="adminEmail" placeholder="Email address"></div>
      <div class="auth-field"><label for="adminAddress">Street address</label><input type="text" id="adminAddress" placeholder="Street address"></div>
      <div class="co-field-row">
        <div class="auth-field"><label for="adminCity">City</label><input type="text" id="adminCity" placeholder="City"></div>
        <div class="auth-field"><label for="adminState">State / Province</label><input type="text" id="adminState" placeholder="State / Province"></div>
      </div>
      <div class="co-field-row">
        <div class="auth-field"><label for="adminZip">Postal code</label><input type="text" id="adminZip" placeholder="Postal code"></div>
        <div class="auth-field"><label for="adminCountry">Country</label><input type="text" id="adminCountry" placeholder="Country" value="United States"></div>
      </div>

      <h3 style="margin-top:30px;">Pricing tier</h3>
      <select class="admin-select" id="adminTier">${tierOptions}</select>

      <h3 style="margin-top:30px;">Items</h3>
      <div class="admin-lines" id="adminLines">${adminLines.map(adminLineRowHTML).join("")}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="adminAddLine" style="margin-top:12px;">+ Add item</button>

      <h3 style="margin-top:30px;">Shipping</h3>
      <select class="admin-select" id="adminShipMethod">${shipOptions}</select>

      <div class="co-actions co-actions-end">
        <button type="button" class="btn btn-primary" id="adminCreateOrder">Create Order</button>
      </div>
    </div>
    <aside class="checkout-summary admin-summary">
      <h4>Order total</h4>
      <div class="co-summary-row"><span>Items subtotal</span><span id="adminSubtotalDisplay">${fmt(adminLinesTotal())}</span></div>
      <div class="co-summary-row"><span>Shipping</span><span id="adminShipDisplay">$0.00</span></div>
      <div class="co-summary-subtotal"><span>Total</span><span id="adminTotalDisplay">${fmt(adminLinesTotal())}</span></div>
    </aside>
  </div></section>
  <section class="panel-bg"><div class="wrap">
    <div class="section-head"><h2>Recent Orders</h2></div>
    <div class="admin-orders-list" id="adminOrdersList">${adminOrdersListHTML()}</div>
  </div></section>`;
}

async function adminFetchRecentOrders() {
  const list = document.getElementById("adminOrdersList");
  if (!list) return;
  try {
    const query = supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    // A stalled connection shouldn't leave "Loading…" up forever.
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 12000));
    const { data, error } = await Promise.race([query, timeout]);
    if (error) throw error;
    adminRecentOrders = data || [];
  } catch (err) {
    adminRecentOrders = [];
  }
  adminOrdersLoaded = true;
  const freshList = document.getElementById("adminOrdersList");
  if (freshList) freshList.innerHTML = adminOrdersListHTML();
}

/* ---- All Orders (admin) — every order placed by every customer,
   reached via the "Orders" link in the header (admin-only). Same
   `orders` table as the Recent Orders preview above, just unbounded
   and with a couple more columns. ---- */
let adminAllOrders = [];
let adminAllOrdersLoaded = false;

function adminOrdersSummaryHTML() {
  if (!adminAllOrdersLoaded) return "";
  const count = adminAllOrders.length;
  const revenue = adminAllOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
  return `
  <div class="admin-orders-summary">
    <div class="admin-orders-stat"><b>${count}</b><span>${count === 1 ? "Order" : "Orders"}</span></div>
    <div class="admin-orders-stat"><b>${fmt(revenue)}</b><span>Total Revenue</span></div>
  </div>`;
}

function adminOrderFullRowHTML(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsSummary = items.map((it) => `${it.name} ×${it.qty}`).join(", ");
  const when = order.created_at ? new Date(order.created_at).toLocaleString() : "—";
  return `
  <div class="admin-order-full-row">
    <div class="aof-main">
      <span class="aof-customer">${esc(order.customer_name || "—")}</span>
      <span class="aof-email mono">${esc(order.customer_email || "no email on file")}</span>
    </div>
    <span class="aof-items mono">${esc(itemsSummary || "no items")}</span>
    <span class="aof-tier">${esc(order.price_tier || "—")}</span>
    <span class="aof-ship">${esc(order.shipping_method || "—")}</span>
    <span class="aof-when mono">${esc(when)}</span>
    <span class="aof-total mono">${fmt(order.total || 0)}</span>
  </div>`;
}

function adminAllOrdersListHTML() {
  if (!adminAllOrdersLoaded) return `<p class="muted" style="padding:20px 0;">Loading orders…</p>`;
  if (!adminAllOrders.length) return "";
  return adminAllOrders.map(adminOrderFullRowHTML).join("");
}

async function adminFetchAllOrders() {
  const list = document.getElementById("adminAllOrdersList");
  if (!list) return;
  try {
    const query = supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(1000);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 12000));
    const { data, error } = await Promise.race([query, timeout]);
    if (error) throw error;
    adminAllOrders = data || [];
  } catch (err) {
    adminAllOrders = [];
  }
  adminAllOrdersLoaded = true;
  const freshList = document.getElementById("adminAllOrdersList");
  if (freshList) freshList.innerHTML = adminAllOrdersListHTML();
  const summaryEl = document.getElementById("adminOrdersSummary");
  if (summaryEl) summaryEl.innerHTML = adminOrdersSummaryHTML();
}

function viewAdminOrders() {
  if (!isAdmin()) {
    return `
    <div class="wrap" style="padding:80px 0;text-align:center;">
      <h1>Admin access only</h1>
      <p class="muted" style="margin-top:12px;">Sign in with the admin account to reach this page.</p>
      <a href="#/" class="btn btn-outline" style="margin-top:22px;">← Back home</a>
    </div>`;
  }
  return `
  <section><div class="wrap">
    <div class="section-head">
      <div>
        <h1 class="shop-title" style="font-size:clamp(28px,3.4vw,40px);">All Orders</h1>
      </div>
      <a href="#/admin" class="btn btn-outline">+ New Order</a>
    </div>
    <div id="adminOrdersSummary">${adminOrdersSummaryHTML()}</div>
    <div class="admin-orders-table">
      <div class="admin-order-full-row admin-order-full-head">
        <span>Customer</span><span>Items</span><span>Tier</span><span>Shipping</span><span>Placed</span><span>Total</span>
      </div>
      <div id="adminAllOrdersList">${adminAllOrdersListHTML()}</div>
    </div>
  </div></section>`;
}

function wireAdminOrdersPage() {
  const list = document.getElementById("adminAllOrdersList");
  if (!list) return;
  adminAllOrdersLoaded = false;
  adminFetchAllOrders();
}

function adminUpdateTotals() {
  const subEl = document.getElementById("adminSubtotalDisplay");
  const shipEl = document.getElementById("adminShipDisplay");
  const totalEl = document.getElementById("adminTotalDisplay");
  const subtotal = adminLinesTotal();
  const ship = adminShipCost();
  if (subEl) subEl.textContent = fmt(subtotal);
  if (shipEl) shipEl.textContent = fmt(ship);
  if (totalEl) totalEl.textContent = fmt(subtotal + ship);
}

function adminRerenderLines() {
  const mount = document.getElementById("adminLines");
  if (!mount) return;
  mount.innerHTML = adminLines.map(adminLineRowHTML).join("");
  wireAdminLineRows();
  adminUpdateTotals();
}

function wireAdminLineRows() {
  const mount = document.getElementById("adminLines");
  if (!mount) return;
  mount.querySelectorAll("[data-admin-field]").forEach((el) => {
    const evt = el.tagName === "SELECT" || el.type === "number" ? "input" : "input";
    el.addEventListener(evt, () => {
      const idx = Number(el.getAttribute("data-idx"));
      const field = el.getAttribute("data-admin-field");
      const line = adminLines[idx];
      if (!line) return;
      if (field === "productId") {
        line.productId = el.value;
        const product = byId[el.value];
        const tierSel = document.getElementById("adminTier");
        if (product && tierSel) line.unitPrice = adminPriceForTier(product, tierSel.value);
        adminRerenderLines();
        return;
      }
      if (field === "qty") line.qty = Math.max(1, Number(el.value) || 1);
      if (field === "unitPrice") line.unitPrice = Math.max(0, Number(el.value) || 0);
      const row = mount.querySelector(`.admin-line-row[data-line-idx="${idx}"] .admin-line-total`);
      if (row) row.textContent = fmt(line.qty * line.unitPrice);
      adminUpdateTotals();
    });
  });
  mount.querySelectorAll("[data-admin-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-admin-remove"));
      if (adminLines.length <= 1) return;
      adminLines.splice(idx, 1);
      adminRerenderLines();
    });
  });
}

function wireAdminPage() {
  const root = document.getElementById("adminCreateOrder");
  if (!root) return;

  adminOrdersLoaded = false;
  adminFetchRecentOrders();

  wireAdminLineRows();
  adminUpdateTotals();

  const tierSel = document.getElementById("adminTier");
  if (tierSel) {
    tierSel.addEventListener("change", () => {
      adminLines.forEach((line) => {
        const product = byId[line.productId];
        if (product) line.unitPrice = adminPriceForTier(product, tierSel.value);
      });
      adminRerenderLines();
    });
  }

  const addLineBtn = document.getElementById("adminAddLine");
  if (addLineBtn) {
    addLineBtn.addEventListener("click", () => {
      const firstProduct = PRODUCTS[0];
      const tier = tierSel ? tierSel.value : "Retail Customer";
      adminLines.push({
        productId: firstProduct ? firstProduct.id : "",
        qty: 1,
        unitPrice: firstProduct ? adminPriceForTier(firstProduct, tier) : 0
      });
      adminRerenderLines();
    });
  }

  const shipSel = document.getElementById("adminShipMethod");
  if (shipSel) shipSel.addEventListener("change", adminUpdateTotals);

  root.addEventListener("click", async () => {
    const name = (document.getElementById("adminName") || {}).value || "";
    if (!name.trim()) { showToast("Enter the customer's name"); return; }
    if (!adminLines.length || adminLines.every((l) => !l.productId)) { showToast("Add at least one item"); return; }

    const shipSelEl = document.getElementById("adminShipMethod");
    const shipMethodInfo = ADMIN_SHIP_METHODS.find((m) => m.key === (shipSelEl ? shipSelEl.value : "none"));
    const shipCost = adminShipCost();
    const items = adminLines
      .filter((l) => l.productId)
      .map((l) => {
        const p = byId[l.productId];
        return { id: l.productId, name: p ? p.name : l.productId, sku: p ? p.sku : "", qty: l.qty, unitPrice: l.unitPrice };
      });
    const subtotal = adminLinesTotal();
    const total = subtotal + shipCost;

    const payload = {
      customer_name: name.trim(),
      customer_email: (document.getElementById("adminEmail") || {}).value || null,
      customer_phone: (document.getElementById("adminPhone") || {}).value || null,
      shipping_address: {
        street: (document.getElementById("adminAddress") || {}).value || "",
        city: (document.getElementById("adminCity") || {}).value || "",
        state: (document.getElementById("adminState") || {}).value || "",
        zip: (document.getElementById("adminZip") || {}).value || "",
        country: (document.getElementById("adminCountry") || {}).value || ""
      },
      items,
      price_tier: tierSel ? tierSel.value : null,
      shipping_method: shipMethodInfo ? shipMethodInfo.label : null,
      shipping_cost: shipCost,
      subtotal,
      total,
      notes: null,
      created_by: currentUser ? currentUser.email : null
    };

    root.disabled = true;
    root.textContent = "Saving…";
    try {
      const { error } = await supabase.from("orders").insert(payload);
      if (error) throw error;
      showToast("Order saved");
      adminLines = [adminDefaultLine()];
      ["adminName", "adminEmail", "adminPhone", "adminAddress", "adminCity", "adminState", "adminZip"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      const countryEl = document.getElementById("adminCountry");
      if (countryEl) countryEl.value = "United States";
      adminRerenderLines();
      adminFetchRecentOrders();
    } catch (err) {
      showToast("Couldn't save the order — make sure the orders table has been created in Supabase");
    } finally {
      root.disabled = false;
      root.textContent = "Create Order";
    }
  });
}

/* =========================================================
   ADMIN PORTAL — PROMO CODES
   No database, no Supabase call — this page just displays the
   PROMO_CODES list defined near the top of this file (search for
   "PROMO CODES" above). To add, change, or disable a code, edit
   that list directly and redeploy the site; there's nothing to
   configure here.
   ========================================================= */
function viewAdminPromoCodes() {
  if (!isAdmin()) {
    return `
    <div class="wrap" style="padding:80px 0;text-align:center;">
      <h1>Admin access only</h1>
      <p class="muted" style="margin-top:12px;">Sign in with the admin account to reach this page.</p>
      <a href="#/" class="btn btn-outline" style="margin-top:22px;">← Back home</a>
    </div>`;
  }
  const rows = Object.entries(PROMO_CODES).map(([code, pct]) => `
    <div class="admin-promo-row">
      <span class="admin-promo-code mono">${esc(code)}</span>
      <span class="admin-promo-discount mono">${pct == null ? "—" : Math.round(pct * 100) + "%"}</span>
      <span>${pct == null ? "Disabled" : "Active"}</span>
    </div>`).join("");
  return `
  <section><div class="wrap">
    <div class="section-head">
      <div><h1 class="shop-title" style="font-size:clamp(28px,3.4vw,40px);">Promo Codes</h1></div>
      <a href="#/admin/orders" class="btn btn-outline">Orders</a>
    </div>
    <div class="admin-promo-table">
      <div class="admin-promo-row admin-promo-head">
        <span>Code</span><span>Discount</span><span>Status</span>
      </div>
      ${rows}
    </div>
  </div></section>`;
}

function wireAdminPromoCodesPage() {
  // Nothing to wire — the list above is static and read-only.
}

/* ---- Compare Peptides (targeted re-render, same pattern as the
   product-family dosage selector) ---- */
let compareIds = ["bpc157-10mg", "tb500-10mg"];

function compareOptionsHTML(selectedId) {
  return SHOP_ITEMS.slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((it) => `<option value="${it.id}"${it.id === selectedId ? " selected" : ""}>${esc(it.name)}</option>`)
    .join("");
}
function compareRow(label, a, b) {
  return `<div class="compare-row"><span class="compare-label mono">${esc(label)}</span><span class="compare-val">${a}</span><span class="compare-val">${b}</span></div>`;
}
function comparePaneHTML() {
  const a = displayItem(compareIds[0]) || displayItem("bpc157-10mg");
  const b = displayItem(compareIds[1]) || displayItem("tb500-10mg");
  const catA = catInfo(a.category);
  const catB = catInfo(b.category);
  const doseA = a.isFamily ? `${a.variantCount} dosages` : a.concentration;
  const doseB = b.isFamily ? `${b.variantCount} dosages` : b.concentration;
  const priceA = a.isFamily ? `From ${fmt(tierPrice(a))}` : fmt(tierPrice(a));
  const priceB = b.isFamily ? `From ${fmt(tierPrice(b))}` : fmt(tierPrice(b));
  return `
  <div class="compare-cards">
    <div class="compare-card">
      <img src="${a.image}" alt="${esc(a.name)}">
      <h3>${esc(a.name)}</h3>
      <select class="compare-select" data-compareslot="0" aria-label="Peptide A">${compareOptionsHTML(a.id)}</select>
    </div>
    <span class="compare-vs mono">VS</span>
    <div class="compare-card">
      <img src="${b.image}" alt="${esc(b.name)}">
      <h3>${esc(b.name)}</h3>
      <select class="compare-select" data-compareslot="1" aria-label="Peptide B">${compareOptionsHTML(b.id)}</select>
    </div>
  </div>
  <div class="compare-table">
    ${compareRow("Category", esc(catA.name), esc(catB.name))}
    ${compareRow("Purity", esc(a.specifications.Purity || "≥99%"), esc(b.specifications.Purity || "≥99%"))}
    ${compareRow("Dosage", esc(doseA), esc(doseB))}
    ${compareRow("Price", priceA, priceB)}
    ${compareRow("Research Focus", esc(titleCase(a.tagline)), esc(titleCase(b.tagline)))}
  </div>`;
}
function wireComparePane() {
  const pane = document.getElementById("comparePane");
  if (!pane) return;
  pane.querySelectorAll("[data-compareslot]").forEach((sel) => {
    sel.addEventListener("change", () => {
      compareIds[Number(sel.getAttribute("data-compareslot"))] = sel.value;
      pane.innerHTML = comparePaneHTML();
      wireComparePane();
    });
  });
}
function viewCompare() {
  return `
  <div class="page-hero info-hero"><div class="wrap">
    <span class="eyebrow">Peptide Information</span>
    <h1>Compare Peptides</h1>
    <p class="lede">Pick two compounds from the catalog to compare purity, dosage, price, and research focus side by side.</p>
  </div></div>
  <section><div class="wrap"><div id="comparePane">${comparePaneHTML()}</div></div></section>`;
}

/* ---- Our Methodology ---- */
const METHOD_STEPS = [
  { title: "Sourcing & Synthesis", desc: "Each compound is synthesized to spec and matched against reference standards before it enters our catalog." },
  { title: "Lyophilization", desc: "Vials are freeze-dried under controlled conditions to preserve potency and extend shelf stability." },
  { title: "Independent HPLC Verification", desc: "A third-party lab runs high-performance liquid chromatography on every batch to confirm purity before release." },
  { title: "Cold-Chain Packaging", desc: "Verified vials are packed with cold-chain materials sized to the shipping distance and season." },
  { title: "Dispatch & Chain of Custody", desc: "Orders ship within 48 hours of verification, with tracking and batch documentation attached to every order." }
];
function viewMethodology() {
  const steps = METHOD_STEPS.map(
    (s, i) => `
    <div class="method-step">
      <span class="method-num mono">${String(i + 1).padStart(2, "0")}</span>
      <div>
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.desc)}</p>
      </div>
    </div>`
  ).join("");

  return `
  <div class="page-hero info-hero"><div class="wrap">
    <span class="eyebrow">Peptide Information</span>
    <h1>Our Methodology</h1>
    <p class="lede">How a compound moves from synthesis to your bench — the process behind every ≥99% purity result we publish.</p>
  </div></div>
  <section><div class="wrap">
    <div class="method-layout">
      <div class="method-steps">${steps}</div>
      <div class="method-visual">
        <img src="/images/methodology-lab.webp" alt="Researcher verifying a HoopBioPharma KPV vial in the lab" loading="lazy">
      </div>
    </div>
  </div></section>
  <section class="about-grid-section" style="padding-top:0;">
    <div class="wrap"><div class="about-cta"><a href="#/shop" class="btn btn-primary">Shop the Catalog</a></div></div>
  </section>`;
}

/* ---- Glossary ---- */
const GLOSSARY_TERMS = [
  { term: "Amino Acid Sequence", def: "The specific order of amino acids linked together to form a peptide. Even a single position swapped changes the compound's identity and behavior.", sections: [
    { h2: "What Determines a Peptide's Identity", body: [
      "A peptide's amino acid sequence is the order in which individual amino acids are joined, read from the N-terminus (amino end) to the C-terminus (carboxyl end). This order isn't just a label — it's the blueprint that determines how the chain folds, what receptors it can interact with, and how stable it is once reconstituted.",
      "Because sequence determines identity, a Certificate of Analysis typically confirms it indirectly — through mass spectrometry and HPLC retention time — rather than sequencing every batch from scratch. A single substituted, deleted, or added residue produces a structurally different compound, even if the name on the label stays the same."
    ] },
    { h2: "How Sequence Is Verified", body: [
      "Because two peptides can share the same molecular formula while differing in the order their residues appear, sequence confirmation relies on more than a single test. Mass spectrometry establishes the compound's overall mass, while techniques like tandem MS/MS fragmentation can confirm the order of specific residues by breaking the chain at predictable points and measuring the resulting fragments.",
      "HPLC retention time offers a secondary check: a peptide with an altered sequence — even one amino acid different — typically elutes at a measurably different time than the reference standard, which is one reason a Certificate of Analysis reports retention time alongside purity."
    ] },
    { h2: "Why a Single Substitution Matters", body: [
      "A sequence isn't just a checklist of ingredients — it's an instruction for how the chain folds and which surfaces it presents. Swapping one amino acid for a similarly sized one can still change the chain's charge distribution or its ability to form specific bonds, altering how it behaves in solution or interacts with a binding partner.",
      "This is why suppliers describe sequence as the foundation of identity: two vials could contain peptides with nearly identical molecular weights and still be functionally different compounds if their underlying sequences diverge."
    ] }
  ], bullets: { heading: "What Sequence Confirmation Involves", items: [
    "Mass spectrometry to confirm overall molecular weight",
    "MS/MS fragmentation to verify residue order",
    "HPLC retention time as a secondary identity check",
    "Comparison against a reference standard for the intended compound"
  ] } },
  { term: "Bioavailability", def: "The proportion of a compound that reaches systemic circulation intact and unmetabolized, relevant to how a research protocol is designed and dosed.", sections: [
    { h2: "What Determines Bioavailability", body: [
      "Bioavailability describes what fraction of an administered compound actually reaches systemic circulation in its active form, and how quickly. It's shaped by the route of administration, the compound's stability, and how readily it's broken down before it can act.",
      "In a research setting, bioavailability is one of the variables that shapes protocol design — it influences dosing intervals, storage handling, and how results are interpreted relative to the amount of compound actually delivered versus the amount administered."
    ] },
    { h2: "Factors That Influence It", body: [
      "Bioavailability isn't a fixed property of a compound — it shifts with the route of administration, the formulation, and how quickly the compound is broken down before it can act. A peptide that's highly stable in one delivery method may be degraded almost entirely by digestive enzymes in another, which is a central reason peptides are typically studied via injection routes rather than oral administration.",
      "Storage and handling before use also play a role: a compound that has degraded due to improper storage will show reduced bioavailability regardless of how it's administered, since a portion of what's delivered is no longer the intended active compound."
    ] },
    { h2: "Why It Shapes Protocol Design", body: [
      "Because bioavailability determines how much of an administered dose is actually available to act, it directly informs how a research protocol is structured — including dosing frequency, the concentration used, and how results are interpreted relative to the amount delivered versus the amount that reached circulation.",
      "Researchers comparing outcomes across studies often need to account for differences in bioavailability between delivery methods, since two studies using the same nominal dose but different routes of administration may not be directly comparable."
    ] }
  ], bullets: { heading: "Factors That Affect Bioavailability", items: [
    "Route of administration",
    "Compound stability and formulation",
    "Storage conditions prior to use",
    "Rate of metabolic breakdown"
  ] } },
  { term: "Bioregulators", def: "Short peptides that occur naturally in the body and act as signaling molecules, often studied for their role in regulating specific cellular processes.", sections: [
    { h2: "What Sets Bioregulators Apart", body: [
      "Bioregulators are naturally occurring short peptides the body uses to relay instructions between cells — telling tissue to repair, regulate inflammation, or adjust its own rate of activity. They're generally shorter and more targeted in action than larger signaling proteins.",
      "Because they mimic signals the body already produces, bioregulators are frequently used in research exploring cellular aging, tissue-specific regulation, and recovery pathways, with studies typically focused on a single organ system or process at a time."
    ] },
    { h2: "How Bioregulators Differ From Other Signaling Peptides", body: [
      "Bioregulators are typically very short — often just a handful of amino acids — and tend to act on a narrow, specific target rather than triggering broad systemic effects. This specificity is part of what makes them useful research tools: their action can often be studied in relative isolation from other signaling pathways.",
      "Unlike synthetic research compounds designed from scratch, bioregulators are modeled on sequences the body already produces, which is why research in this category frequently focuses on understanding or replicating a naturally occurring regulatory process rather than introducing a novel mechanism."
    ] },
    { h2: "Common Areas of Study", body: [
      "Bioregulator research spans a range of tissue-specific processes, including studies related to cellular aging, recovery and repair pathways, and the regulation of organ-specific function. Because each bioregulator tends to correspond to a particular tissue or system, researchers often select a specific compound based on the biological process they're investigating.",
      "As with all research peptides, bioregulators used in laboratory settings are accompanied by documentation confirming their identity and purity, since their short length and structural similarity to related peptides make independent verification especially important."
    ] }
  ], bullets: { heading: "Characteristics of Bioregulators", items: [
    "Very short amino acid sequences",
    "Narrow, tissue-specific mechanisms of action",
    "Modeled on naturally occurring signaling peptides",
    "Studied across a range of organ-specific processes"
  ] } },
  { term: "CAS Number", def: "A unique numeric identifier assigned by the Chemical Abstracts Service to a specific chemical substance, used to unambiguously reference a compound across suppliers and literature.", sections: [
    { h2: "What a CAS Number Is", body: [
      "A CAS Number (Chemical Abstracts Service Registry Number) is a unique numeric tag assigned to a specific chemical substance the first time it's indexed in the CAS database. It has no chemical meaning on its own — it's purely an identifier.",
      "Because names and abbreviations can vary between suppliers, papers, and regions, the CAS Number is the fastest way to confirm that two listings — or a Certificate of Analysis and a product label — refer to the exact same compound."
    ] },
    { h2: "How a CAS Number Is Assigned", body: [
      "CAS Numbers are issued by the Chemical Abstracts Service, a division of the American Chemical Society, as substances are newly indexed in their registry. Each number is permanent and specific to one substance — it's never reissued or reused, even if a compound falls out of common use.",
      "The number itself follows a simple format: a string of digits split into three groups by hyphens, with the final digit acting as a check digit calculated from the rest. This structure allows quick validation that a CAS Number is at least correctly formatted, independent of confirming which substance it refers to."
    ] },
    { h2: "Why It's Useful for Verification", body: [
      "Product names can vary — a compound might be listed under a brand name, an abbreviation, or a full chemical name depending on the source. The CAS Number cuts through that variation, giving researchers a single reference point to confirm that a listing, a safety data sheet, and a Certificate of Analysis all describe the same underlying substance.",
      "When comparing suppliers or cross-referencing a compound against published research, checking the CAS Number is a faster and more reliable first step than comparing product names alone."
    ] }
  ], bullets: { heading: "Why the CAS Number Matters", items: [
    "Uniquely and permanently identifies a specific substance",
    "Unaffected by differences in brand or product naming",
    "Used to cross-reference COAs, SDS sheets, and literature",
    "Format includes a built-in check digit for validation"
  ] } },
  { term: "Certificate of Analysis (COA)", def: "A lab-issued document reporting the actual test results — purity, identity, and other specifications — for a specific manufactured batch.", sections: [
    { h2: "What a Certificate of Analysis Is", body: [
      "A Certificate of Analysis is the lab report issued for a specific manufactured batch, documenting what an independent or in-house lab actually measured — purity by HPLC, identity by mass spectrometry, and often additional screens like endotoxin or residual solvent testing.",
      "Because a COA is tied to a batch or lot number rather than a product line in general, it reflects what that particular vial contains, not a general claim about the product. Matching the lot number on your vial to the lot number on the COA is how you confirm you're looking at the right document."
    ] },
    { h2: "What a COA Typically Includes", body: [
      "A complete COA reports the specific tests performed on a batch and their results — most commonly purity by HPLC and identity by mass spectrometry, alongside the batch or lot number, the date of testing, and the testing lab's identifying information. Many COAs also include additional screens, such as endotoxin testing, depending on the compound and intended use.",
      "A COA from an independent third-party lab carries more weight than an in-house report, since it removes any incentive for the results to be presented favorably. Reputable suppliers typically indicate clearly whether a COA reflects third-party or internal testing."
    ] },
    { h2: "How to Read One", body: [
      "The most important step when reviewing a COA is matching its lot number to the lot number printed on the vial itself. A COA for the wrong batch — even from the same supplier and product line — doesn't confirm anything about the vial in hand.",
      "From there, the purity percentage and the identity confirmation (usually a molecular weight match via mass spectrometry) are the two figures worth checking first, since together they answer the two most basic questions: is this the intended compound, and how much of the sample actually consists of it."
    ] }
  ], bullets: { heading: "What to Check on a COA", items: [
    "Lot number matches the vial",
    "Purity result and test method (typically HPLC)",
    "Identity confirmation (typically mass spectrometry)",
    "Testing lab and whether it's third-party or in-house",
    "Date of testing"
  ] } },
  { term: "Endotoxin Testing", def: "A test (commonly LAL) that screens a batch for bacterial endotoxins, confirming it falls within an acceptable limit for research use.", sections: [
    { h2: "What Endotoxin Testing Checks For", body: [
      "Endotoxin testing screens a batch for bacterial endotoxins — remnants of the outer membrane of gram-negative bacteria — that can be introduced during manufacturing even when the peptide itself is pure. The most common method is the LAL (Limulus Amebocyte Lysate) assay.",
      "Results are reported in EU/mg (endotoxin units per milligram) and compared against an acceptable threshold for research use. This test is separate from purity and identity testing — a batch can be chemically pure and still fail an endotoxin screen if manufacturing conditions weren't adequately controlled."
    ] },
    { h2: "How the LAL Assay Works", body: [
      "The LAL (Limulus Amebocyte Lysate) assay uses a reagent derived from horseshoe crab blood cells, which react to bacterial endotoxins through a clotting or color-change response. The strength of that response is used to calculate the endotoxin concentration in a sample, reported in endotoxin units per milligram (EU/mg).",
      "Because the assay is sensitive to very low concentrations, it can detect contamination that wouldn't be apparent from purity or identity testing alone — a batch can measure at high purity by HPLC and still carry an endotoxin level above an acceptable threshold if manufacturing conditions introduced bacterial contamination."
    ] },
    { h2: "Why It's Tested Separately From Purity", body: [
      "Purity and identity testing confirm what a sample chemically consists of; endotoxin testing addresses a different question entirely — whether the manufacturing and packaging process introduced biological contaminants along the way. A peptide can be correctly synthesized and still pick up endotoxins from water, glassware, or raw materials used during production.",
      "For this reason, a thorough Certificate of Analysis treats endotoxin testing as its own line item rather than folding it into a general purity claim, and researchers evaluating a supplier's documentation should expect to see it listed separately when it's included at all."
    ] }
  ], bullets: { heading: "Key Facts About Endotoxin Testing", items: [
    "Most commonly performed via the LAL assay",
    "Reported in EU/mg (endotoxin units per milligram)",
    "Screens for contamination, not chemical purity",
    "Compared against a defined acceptable threshold"
  ] } },
  { term: "GMP (Good Manufacturing Practices)", def: "A set of quality-system standards covering facilities, processes, and documentation, aimed at producing consistent, well-controlled batches.", sections: [
    { h2: "What GMP Means", body: [
      "GMP refers to a set of quality-system requirements governing how a product is manufactured — covering facility conditions, equipment qualification, staff training, documentation, and batch traceability. It's a process standard, not a claim about any single batch's test results.",
      "A facility operating under GMP-aligned practices is set up to produce consistent, well-documented batches run after run, which is what makes third-party testing results meaningful — the process that produced the batch is itself accounted for and repeatable."
    ] },
    { h2: "What GMP Covers", body: [
      "GMP requirements span the full manufacturing environment — facility cleanliness and design, equipment calibration and maintenance, staff training, and the documentation trail connecting raw materials to a finished, labeled batch. The goal is that any given batch could, in principle, be traced back through every step of its production.",
      "This documentation trail is what makes batch-to-batch consistency possible: if an issue is identified in one batch, GMP records make it possible to determine which other batches might share the same raw material lot or processing step."
    ] },
    { h2: "How It Relates to Testing", body: [
      "GMP and third-party testing address different parts of the same problem. GMP is about how consistently and carefully a batch was produced; testing (via HPLC, mass spectrometry, and similar methods) confirms what that specific batch actually contains. A facility can follow GMP-aligned processes and still test each batch, with the process controls making it more likely that testing results are representative and repeatable.",
      "When evaluating a supplier, GMP-aligned manufacturing and independent batch testing are complementary signals — one speaks to the process, the other to the specific vial in hand."
    ] }
  ], bullets: { heading: "What GMP-Aligned Manufacturing Involves", items: [
    "Controlled, documented facility and equipment standards",
    "Trained personnel following defined procedures",
    "Batch traceability from raw material to finished product",
    "A consistent, repeatable production process"
  ] } },
  { term: "Half-Life", def: "The time it takes for half of a given amount of a compound to be cleared or broken down, a key variable in designing a research timeline.", sections: [
    { h2: "What Half-Life Measures", body: [
      "Half-life is the time required for the concentration of a compound in a system to fall to half of its starting value, through clearance, metabolism, or degradation. It's typically reported in minutes, hours, or days depending on the compound.",
      "Half-life is one of the core variables in designing a research timeline — it informs how frequently a compound needs to be reintroduced to maintain a given concentration, and how long effects might reasonably be expected to persist after the last administration."
    ] },
    { h2: "What Influences Half-Life", body: [
      "A compound's half-life depends on how it's cleared from the system — primarily through metabolic breakdown, but also through mechanisms like renal filtration depending on the compound's size and structure. Larger or more structurally complex peptides are sometimes cleared more slowly simply because they take longer to break down into smaller fragments.",
      "Formulation and route of administration can also shift a compound's effective half-life, since a slower-releasing delivery method extends the period over which the compound enters circulation, even if its underlying breakdown rate doesn't change."
    ] },
    { h2: "Half-Life in Practice", body: [
      "In research design, half-life informs the interval between administrations needed to maintain a relatively stable concentration, and it shapes expectations about how quickly effects should be expected to taper off after the last dose. A compound with a short half-life requires more frequent administration to sustain a given concentration than one with a long half-life.",
      "It's typically reported as an approximate range rather than a single fixed number, since actual clearance rates can vary based on the specific research model and conditions used."
    ] }
  ], bullets: { heading: "What Affects a Compound's Half-Life", items: [
    "Molecular size and structural complexity",
    "Route of administration and formulation",
    "Rate of enzymatic or metabolic breakdown",
    "The specific research model and conditions used"
  ] } },
  { term: "HPLC (High-Performance Liquid Chromatography)", def: "An analytical method that separates a sample's components to measure purity and confirm identity against a reference standard.", sections: [
    { h2: "How HPLC Works", body: [
      "High-Performance Liquid Chromatography separates the components of a sample by pumping it, under high pressure, through a column packed with a material that interacts differently with each component. The result is a chromatogram — a series of peaks, each corresponding to a different substance in the sample.",
      "For peptide testing, HPLC is the primary method used to measure purity: the area of the peak matching the target compound, as a percentage of all peaks detected, gives the reported purity percentage on a Certificate of Analysis."
    ] },
    { h2: "Reading an HPLC Chromatogram", body: [
      "A chromatogram displays a series of peaks along a timeline, each representing a different component detected in the sample. The peak matching the retention time of the intended compound — established against a known reference standard — is used to calculate purity, expressed as that peak's area relative to the total area of all peaks detected.",
      "Smaller secondary peaks typically represent byproducts of synthesis or minor degradation, and their size relative to the main peak is part of what a purity percentage communicates: a 99% purity result means the target peak accounts for 99% of the total detected peak area."
    ] },
    { h2: "HPLC Alongside Other Methods", body: [
      "HPLC measures purity, but it doesn't on its own confirm identity — a sample could contain a single clean peak that still isn't the intended compound. That's why a thorough Certificate of Analysis pairs HPLC purity results with a separate identity check, most often mass spectrometry.",
      "Together, the two methods answer complementary questions: HPLC tells you how clean the sample is, and mass spectrometry confirms that what's clean is actually the compound it's labeled as."
    ] }
  ], bullets: { heading: "What an HPLC Result Tells You", items: [
    "Purity percentage relative to total detected material",
    "Retention time, used to help confirm identity",
    "Presence and relative size of secondary peaks",
    "Comparison against a known reference standard"
  ] } },
  { term: "In Vitro Research", def: "Research conducted outside of a living organism — in a test tube, culture dish, or controlled lab environment.", sections: [
    { h2: "What In Vitro Research Means", body: [
      "In vitro research is conducted outside of a living organism — in cell cultures, tissue samples, or other controlled laboratory systems, typically in a dish, plate, or test tube ('in vitro' is Latin for 'within the glass').",
      "It's often the first stage of investigating a compound's activity, since it allows precise control over conditions and concentration, before questions about whole-organism behavior are explored through in vivo research."
    ] },
    { h2: "Common In Vitro Methods", body: [
      "In vitro work spans a range of setups, from simple cell cultures grown in a dish to more complex tissue models designed to mimic specific physiological conditions. Because the environment is fully controlled, researchers can isolate a single variable — a specific concentration, exposure time, or cell type — and observe its effect without the confounding factors present in a whole organism.",
      "This makes in vitro research particularly useful for early-stage screening: testing a compound's basic activity, toxicity profile, or interaction with a specific receptor before committing to the more resource-intensive step of in vivo study."
    ] },
    { h2: "Limitations to Keep in Mind", body: [
      "The same isolation that makes in vitro research useful is also its limitation — a cultured cell doesn't experience circulation, immune response, or interaction with other organ systems, so results don't always translate directly to how a compound behaves in a living organism.",
      "For this reason, in vitro findings are typically treated as a starting point rather than a conclusion, informing which compounds and conditions are worth carrying forward into in vivo research."
    ] }
  ], bullets: { heading: "Typical In Vitro Setups", items: [
    "Cell culture in a dish or plate",
    "Tissue or organoid models",
    "Enzyme or receptor-binding assays",
    "Cytotoxicity and viability screening"
  ] } },
  { term: "In Vivo Research", def: "Research conducted within a living organism, as opposed to isolated cells or tissue in a lab setting.", sections: [
    { h2: "What In Vivo Research Means", body: [
      "In vivo research is conducted within a living organism, capturing the full complexity of interacting systems — circulation, metabolism, immune response — that isolated cells in a dish can't replicate.",
      "It typically follows in vitro work, once a compound's basic activity has been characterized, and it's where researchers study systemic effects, dosing behavior, and interactions that only emerge in a whole organism."
    ] },
    { h2: "What In Vivo Studies Can Reveal", body: [
      "Because in vivo research takes place within a living organism, it captures interactions that isolated systems can't — how a compound is absorbed, distributed, metabolized, and cleared, and how multiple organ systems respond to and interact with it over time.",
      "This makes in vivo research the stage where questions about dosing, timing, and systemic effects are typically explored, building on the more targeted findings established during in vitro work."
    ] },
    { h2: "How It Fits Into a Research Program", body: [
      "In vivo research is generally more resource- and time-intensive than in vitro work, which is part of why it typically follows rather than replaces earlier-stage screening. By the time a compound reaches in vivo study, its basic activity and safety profile have usually already been characterized in simpler systems.",
      "Findings from in vivo research carry more weight toward understanding real-world behavior, but they also introduce more variables — meaning results can vary more between studies than the more tightly controlled conditions of in vitro work."
    ] }
  ], bullets: { heading: "What In Vivo Research Can Capture", items: [
    "Absorption, distribution, and clearance",
    "Interactions across multiple organ systems",
    "Systemic and long-term effects",
    "Real-world dosing and timing behavior"
  ] } },
  { term: "ISO 17025", def: "An international standard specifying the general requirements for the competence of testing and calibration laboratories.", sections: [
    { h2: "What ISO 17025 Covers", body: [
      "ISO/IEC 17025 is an international standard that sets out the general requirements for the competence of testing and calibration laboratories — covering everything from staff qualification and equipment calibration to how results are documented and reported.",
      "A lab accredited to ISO 17025 has had its testing methods and quality system independently assessed against this standard, which is part of why third-party COAs from accredited labs carry more weight than in-house results alone."
    ] },
    { h2: "What Accreditation Involves", body: [
      "Earning ISO 17025 accreditation requires a lab to demonstrate both technical competence and a functioning quality management system — meaning assessors review not just whether a lab can produce accurate results, but whether its processes, equipment calibration, and staff training reliably support that accuracy over time.",
      "Accreditation is typically scoped to specific test methods rather than granted blanket to an entire lab, so it's worth checking that a lab's ISO 17025 accreditation actually covers the specific tests — like HPLC purity analysis — being cited in a Certificate of Analysis."
    ] },
    { h2: "Why It Matters for Buyers", body: [
      "Testing results carry more weight when they come from a lab that has been independently verified to meet a recognized competency standard, rather than a lab whose methods and quality controls haven't been externally reviewed.",
      "When comparing suppliers, a COA from an ISO 17025-accredited lab — especially one with no financial relationship to the seller — offers a stronger basis for confidence than an unaccredited or in-house test result."
    ] }
  ], bullets: { heading: "What ISO 17025 Accreditation Signals", items: [
    "Independently verified technical competence",
    "Documented, audited quality management processes",
    "Accreditation scoped to specific test methods",
    "A recognized standard used internationally"
  ] } },
  { term: "Lyophilization (Freeze-Drying)", def: "A dehydration process that freezes a compound and then removes the ice by sublimation, producing a stable powder for storage and shipping.", sections: [
    { h2: "What Lyophilization Is", body: [
      "Lyophilization, or freeze-drying, removes moisture from a compound by first freezing it, then lowering the surrounding pressure so the ice sublimates directly from solid to vapor, bypassing the liquid stage entirely.",
      "The result is a stable, dry powder that's far less prone to degradation during storage and shipping than a liquid solution would be — which is why most peptides are shipped lyophilized and reconstituted just before use."
    ] },
    { h2: "The Freeze-Drying Process", body: [
      "Lyophilization happens in three main stages: freezing the sample solid, then reducing the surrounding pressure so the ice sublimates directly into vapor (primary drying), followed by a secondary drying stage that removes any remaining bound moisture. The result is a dry, porous powder with very low residual moisture content.",
      "Because sublimation bypasses the liquid phase, lyophilization avoids much of the heat-related and mechanical stress that other drying methods can place on a peptide's structure, which is part of why it's the preferred method for preserving delicate compounds."
    ] },
    { h2: "Why It Matters for Storage and Shipping", body: [
      "A lyophilized peptide is significantly more stable than the same compound in solution, since most degradation pathways require the presence of water to proceed. This stability is what allows peptides to be shipped and stored for extended periods without refrigeration in many cases, though manufacturer guidance should always be followed.",
      "Once reconstituted, however, the clock resets — a peptide in solution is exposed to the same degradation pathways lyophilization was protecting against, which is why reconstituted peptides typically carry a much shorter recommended shelf life."
    ] }
  ], bullets: { heading: "Why Peptides Are Shipped Lyophilized", items: [
    "Removes water without high-heat exposure",
    "Significantly extends stable shelf life",
    "Reduces the risk of degradation during transit",
    "Reconstituted only when ready for use"
  ] } },
  { term: "Mass Spectrometry", def: "An analytical technique that measures the mass-to-charge ratio of ions to confirm a compound's molecular identity and weight.", sections: [
    { h2: "What Mass Spectrometry Measures", body: [
      "Mass spectrometry identifies a compound by measuring the mass-to-charge ratio of its ionized fragments, producing a spectrum that acts as a molecular fingerprint.",
      "For peptide testing, it's the standard method for confirming identity — verifying that a sample's measured molecular weight matches the expected weight for the intended sequence, independent of the purity percentage reported by HPLC."
    ] },
    { h2: "How the Measurement Works", body: [
      "A mass spectrometer ionizes a sample, then measures how those ions behave when subjected to an electric or magnetic field — their mass-to-charge ratio determines the pattern they produce. That pattern is translated into a spectrum, with peaks corresponding to the various ionized fragments and the intact molecule itself.",
      "For peptides, this process can reveal not just the total molecular weight but also structural information from how the chain fragments, since peptide bonds tend to break at predictable points under the right ionization conditions."
    ] },
    { h2: "Its Role Alongside Purity Testing", body: [
      "Mass spectrometry and HPLC purity testing serve different purposes on a Certificate of Analysis: HPLC establishes how much of the sample matches a given retention time, while mass spectrometry confirms that the substance at that retention time actually has the expected molecular weight for the intended compound.",
      "A result from mass spectrometry that doesn't match the expected weight is a clear signal that something is wrong with the sample — either a synthesis error, degradation, or a mislabeled product — regardless of what the purity percentage shows."
    ] }
  ], bullets: { heading: "What Mass Spectrometry Confirms", items: [
    "Total molecular weight of the compound",
    "Structural information from fragmentation patterns",
    "Identity confirmation independent of purity testing",
    "Detection of synthesis errors or degradation products"
  ] } },
  { term: "Molecular Weight", def: "The total mass of a compound's molecule, usually reported in daltons, used to help confirm identity and calculate reconstitution concentrations.", sections: [
    { h2: "What Molecular Weight Is", body: [
      "Molecular weight is the total mass of a single molecule of a compound, usually reported in daltons (Da) or kilodaltons (kDa). For peptides, it's a direct function of the amino acid sequence and length.",
      "It's used to confirm identity alongside mass spectrometry, and it's also the figure used to calculate reconstitution concentrations — converting between milligrams of powder and a target molar or mg/mL concentration in solution."
    ] },
    { h2: "How It's Calculated and Measured", body: [
      "A peptide's theoretical molecular weight can be calculated directly from its amino acid sequence, since each amino acid contributes a known mass. The measured molecular weight — determined via mass spectrometry — is then compared against that theoretical value to confirm the sample matches the intended compound.",
      "A close match between theoretical and measured molecular weight is one of the clearest identity checks available, since even a single incorrect or missing amino acid produces a measurable difference in mass."
    ] },
    { h2: "Why Researchers Need It", body: [
      "Beyond identity confirmation, molecular weight is a practical figure needed for reconstitution: converting a target concentration (in mg/mL or a molar concentration) into the correct amount of solvent to add to a given quantity of peptide requires knowing the compound's molecular weight.",
      "It's also relevant when comparing compounds — two peptides with similar names or functions can have meaningfully different molecular weights, which affects everything from solubility to how dosing is typically discussed in research literature."
    ] }
  ], bullets: { heading: "What Molecular Weight Is Used For", items: [
    "Confirming identity alongside mass spectrometry",
    "Calculating reconstitution concentrations",
    "Comparing related compounds",
    "Cross-referencing published research"
  ] } },
  { term: "Peptide Bonds", def: "The covalent bonds that link amino acids together in a chain, formed between the carboxyl group of one amino acid and the amino group of the next.", sections: [
    { h2: "What a Peptide Bond Is", body: [
      "A peptide bond is the covalent bond that links one amino acid to the next, formed when the carboxyl group (–COOH) of one amino acid reacts with the amino group (–NH2) of another, releasing a water molecule in the process.",
      "A chain of amino acids connected end-to-end by peptide bonds is what defines a peptide — the number and sequence of these bonds is effectively the compound's structural backbone."
    ] },
    { h2: "The Chemistry Behind the Bond", body: [
      "A peptide bond forms through a condensation reaction: the carboxyl group of one amino acid reacts with the amino group of the next, releasing a molecule of water as the two are joined. This reaction repeats along the chain, with each new amino acid extending the sequence from what's called the C-terminus.",
      "The resulting bond is notably rigid and planar due to partial double-bond character, which constrains how the chain can fold — a structural detail that plays a role in determining a peptide's overall three-dimensional shape."
    ] },
    { h2: "Why Bond Integrity Matters", body: [
      "Because the peptide bond is what holds the sequence together, its integrity is directly tied to the compound's stability. Certain conditions — extreme pH, heat, or specific enzymes — can hydrolyze peptide bonds, breaking the chain into shorter fragments or individual amino acids.",
      "This is part of why storage conditions matter so much for peptide stability: minimizing exposure to conditions that promote hydrolysis helps preserve the intact chain, and by extension, the compound's intended structure and activity."
    ] }
  ], bullets: { heading: "What Can Break Down Peptide Bonds", items: [
    "Extreme pH conditions",
    "Elevated temperature",
    "Specific hydrolytic enzymes",
    "Prolonged exposure in solution"
  ] } },
  { term: "Peptide Purification", def: "The process of isolating a target peptide from synthesis byproducts and impurities, typically using chromatography, before it's tested and packaged.", sections: [
    { h2: "What Purification Does", body: [
      "Purification is the step after synthesis where the target peptide is isolated from the byproducts, incomplete sequences, and reagents left over from the synthesis process — most commonly using preparative HPLC.",
      "A well-purified batch has a cleaner chromatogram, with fewer and smaller secondary peaks, which is reflected in a higher reported purity percentage once it reaches testing."
    ] },
    { h2: "How Purification Works", body: [
      "Preparative HPLC is the most common purification method: a crude synthesis mixture is passed through a column that separates components based on their chemical properties, allowing the fraction containing the target peptide to be isolated and collected separately from byproducts and incomplete sequences.",
      "Multiple purification passes are sometimes needed to reach a high purity target, with each pass narrowing the collected fraction further — a process that involves a tradeoff between purity and total yield, since more aggressive purification typically means discarding more borderline material."
    ] },
    { h2: "Why Purification Precedes Testing", body: [
      "A crude, unpurified synthesis product typically contains a mix of the target peptide alongside truncated sequences, deletion products, and leftover reagents. Purification is what transforms that mixture into a product suitable for its intended use, and it directly determines what purity percentage the batch will ultimately achieve.",
      "Testing then confirms the result: a well-purified batch shows a clean chromatogram dominated by a single major peak, which is what a high purity percentage on a Certificate of Analysis reflects."
    ] }
  ], bullets: { heading: "What Purification Removes", items: [
    "Incomplete or truncated peptide sequences",
    "Synthesis byproducts and side reactions",
    "Leftover reagents and solvents",
    "Degradation products from the synthesis process"
  ] } },
  { term: "Peptide Purity", def: "The percentage of a sample that consists of the intended compound, as opposed to synthesis byproducts or degradation products, as verified by HPLC.", sections: [
    { h2: "What Purity Means", body: [
      "Purity is the percentage of a sample that consists of the intended compound, rather than synthesis byproducts, truncated sequences, or degradation products. It's measured by HPLC, expressed as the area of the target peak relative to total peak area.",
      "A purity figure near 99% means the vast majority of detected material matches the intended peptide — it doesn't guarantee the identity of that material on its own, which is why purity and identity testing (via mass spectrometry) are typically reported together."
    ] },
    { h2: "How Purity Is Measured", body: [
      "Purity is calculated from an HPLC chromatogram as the area of the peak matching the target compound's retention time, expressed as a percentage of the total area of all peaks detected in the sample. A 99% purity result means that peak accounts for 99% of everything detected — not that the compound is 99% chemically perfect in some broader sense.",
      "This is a relative measurement, dependent on what the method can actually detect and separate — which is part of why purity results are typically reported alongside the specific test method and reference standard used."
    ] },
    { h2: "What Purity Doesn't Tell You", body: [
      "A high purity result confirms that most of the detected material matches a specific retention time — it doesn't, on its own, confirm that the substance at that retention time is definitely the intended compound. That's the role of identity testing, typically via mass spectrometry.",
      "This is why a thorough Certificate of Analysis reports purity and identity as two separate results rather than treating a purity percentage as sufficient proof of what a sample contains."
    ] }
  ], bullets: { heading: "Reading a Purity Result", items: [
    "Expressed as a percentage of total detected peak area",
    "Measured via HPLC against a reference standard",
    "Reported alongside — not instead of — identity testing",
    "A relative, method-dependent measurement"
  ] } },
  { term: "Peptide Solubility", def: "How readily a peptide dissolves in a given solvent, which depends on its sequence and affects how it's reconstituted for use.", sections: [
    { h2: "What Determines Solubility", body: [
      "Solubility describes how readily a peptide dissolves in a given solvent, which depends heavily on its sequence — particularly the balance of hydrophobic and hydrophilic (charged or polar) amino acids it contains.",
      "Some peptides dissolve easily in bacteriostatic water; others require a different solvent, a lower pH, or a slower reconstitution process. Solubility guidance is typically specific to each compound rather than universal."
    ] },
    { h2: "What Determines a Peptide's Solubility", body: [
      "Solubility largely comes down to a peptide's amino acid composition — specifically, the balance between hydrophobic (water-repelling) and hydrophilic (water-attracting) residues in its sequence. A sequence dominated by hydrophobic amino acids tends to dissolve less readily in water-based solvents like bacteriostatic water.",
      "Peptide length and any modifications to the sequence can also affect solubility, which is why reconstitution guidance is typically specific to each compound rather than following a single universal rule."
    ] },
    { h2: "Working With Difficult-to-Dissolve Peptides", body: [
      "For peptides that don't dissolve easily in bacteriostatic water alone, manufacturers sometimes recommend an alternative approach — a small amount of acetic acid or a different solvent to help initiate dissolution, followed by dilution to the final working concentration.",
      "Attempting to force a difficult peptide into solution with excessive agitation or heat can risk degrading the compound, so following compound-specific guidance is generally preferable to a one-size-fits-all approach."
    ] }
  ], bullets: { heading: "What Affects Peptide Solubility", items: [
    "Ratio of hydrophobic to hydrophilic amino acids",
    "Sequence length and any structural modifications",
    "Solvent choice and pH",
    "Temperature and reconstitution technique"
  ] } },
  { term: "Peptide Storage", def: "Guidance on temperature, light exposure, and humidity conditions for keeping a peptide — lyophilized or reconstituted — stable until use.", sections: [
    { h2: "What Storage Guidance Covers", body: [
      "Storage guidance covers the temperature, light exposure, and humidity conditions that keep a peptide stable — both in its lyophilized (powder) form and after it's been reconstituted into solution.",
      "Lyophilized peptides are generally more stable and can often tolerate longer storage at refrigerated or even room temperature for short periods, while reconstituted peptides typically need refrigeration and have a much shorter usable window before degradation becomes a concern."
    ] },
    { h2: "Storage Conditions by Form", body: [
      "Lyophilized peptides are the most stable form and are generally recommended for storage in a freezer for long-term keeping, though many can tolerate refrigeration or brief periods at room temperature without significant degradation — manufacturer guidance should always be the deciding factor.",
      "Once reconstituted, a peptide should typically be refrigerated and used within the timeframe specified by the manufacturer, since dissolved peptides are considerably more vulnerable to degradation from temperature, light, and microbial contamination than their lyophilized form."
    ] },
    { h2: "Signs a Peptide May Have Degraded", body: [
      "Visual cues aren't always reliable, but cloudiness, discoloration, or visible particulates in a reconstituted solution that was previously clear can indicate degradation or contamination. When in doubt, a compound that has been stored outside its recommended conditions is generally best discarded rather than used.",
      "Keeping a simple log of reconstitution dates alongside storage conditions makes it easier to track a peptide's remaining usable window, particularly when working with multiple compounds on different timelines."
    ] }
  ], bullets: { heading: "General Storage Guidelines", items: [
    "Store lyophilized peptides frozen or refrigerated, away from light",
    "Refrigerate reconstituted solution and use within the recommended window",
    "Avoid repeated freeze-thaw cycles once reconstituted",
    "Discard solution showing cloudiness or discoloration"
  ] } },
  { term: "Peptide Synthesis", def: "The process of chemically building a peptide chain, most commonly through solid-phase synthesis, by adding one amino acid at a time.", sections: [
    { h2: "How Peptides Are Synthesized", body: [
      "Peptide synthesis is the process of chemically assembling a peptide chain, most commonly through solid-phase peptide synthesis (SPPS), where amino acids are added one at a time to a chain anchored to a solid resin support.",
      "Each addition involves protecting, coupling, and deprotection steps to ensure amino acids link in the correct order and only at the intended position — errors at any step can produce truncated or incorrect sequences, which purification and testing are designed to catch."
    ] },
    { h2: "How Solid-Phase Synthesis Works", body: [
      "SPPS builds a peptide chain on a solid resin support, adding one protected amino acid at a time through repeated cycles of coupling and deprotection. Anchoring the growing chain to a solid support allows excess reagents to be rinsed away between steps without losing the partially built peptide, which is what makes the process practical to automate.",
      "Once the full sequence is assembled, the chain is cleaved from the resin and any remaining protecting groups are removed, yielding the crude peptide product — which then moves on to purification before testing."
    ] },
    { h2: "Where Errors Can Occur", body: [
      "Each coupling step carries some risk of incomplete reaction, producing a truncated sequence missing one or more amino acids, or of side reactions that introduce an unintended modification. These errors accumulate slightly with each additional residue, which is part of why longer peptides are generally more difficult to synthesize at high purity than shorter ones.",
      "Purification and testing exist specifically to catch and remove these synthesis errors — a well-run purification step separates the correctly assembled full-length peptide from these near-miss byproducts before it ever reaches a customer."
    ] }
  ], bullets: { heading: "Steps in Solid-Phase Peptide Synthesis", items: [
    "Anchor the first amino acid to a solid resin",
    "Repeat coupling and deprotection for each residue",
    "Cleave the completed chain from the resin",
    "Remove remaining protecting groups"
  ] } },
  { term: "Peptides vs. Proteins", def: "Peptides and proteins are both amino acid chains; the distinction is largely one of size, with peptides generally referring to shorter chains (roughly under 50 amino acids).", sections: [
    { h2: "What Separates the Two", body: [
      "Peptides and proteins are both chains of amino acids linked by peptide bonds, built from the same molecular building blocks — the distinction between them is mostly one of size and structural complexity rather than composition.",
      "Peptides generally refer to shorter chains, often cited as roughly under 50 amino acids, while proteins are longer chains that typically fold into more complex, stable three-dimensional structures. The line between the two categories is a convention, not a strict rule."
    ] },
    { h2: "Where the Line Is Drawn", body: [
      "There's no single official cutoff separating a peptide from a protein — the commonly cited threshold of roughly 50 amino acids is a convention rather than a strict rule, and some sources place the line elsewhere. What matters more functionally is structural complexity: proteins typically fold into stable, defined three-dimensional structures, while peptides are often more flexible and less rigidly structured.",
      "This structural difference has practical consequences — proteins' complex folded shapes are part of what makes them harder to synthesize artificially at scale, while peptides' relative simplicity is part of why chemical synthesis is a practical, widely used production method."
    ] },
    { h2: "Why the Distinction Matters in Research", body: [
      "Understanding whether a compound is best described as a peptide or a protein helps set expectations about its behavior — stability, synthesis method, and how it's likely to interact with biological systems all correlate loosely with size and structural complexity.",
      "In practice, the terms are sometimes used loosely even by researchers, so it's generally more useful to look at a compound's actual sequence length and structural properties than to rely on the peptide-versus-protein label alone."
    ] }
  ], bullets: { heading: "Peptides vs. Proteins at a Glance", items: [
    "Peptides: typically shorter, more flexible chains",
    "Proteins: typically longer, with defined folded structures",
    "Both are built from the same amino acid building blocks",
    "The dividing line is a convention, not a strict rule"
  ] } },
  { term: "Reconstitution", def: "The process of dissolving a lyophilized peptide in a solvent — typically bacteriostatic water — to prepare it for use in a research protocol.", sections: [
    { h2: "What Reconstitution Involves", body: [
      "Reconstitution is the process of dissolving a lyophilized (freeze-dried) peptide in a solvent — most commonly bacteriostatic water — to prepare it for use in a research protocol.",
      "The amount of solvent added determines the final concentration, which is why reconstitution instructions typically pair a specific volume with the vial's stated peptide content. Reconstituted solution has a shorter stable shelf life than the lyophilized powder and generally needs refrigeration."
    ] },
    { h2: "The Reconstitution Process", body: [
      "Reconstitution starts with calculating the volume of solvent needed to reach a target concentration, based on the peptide's stated content per vial. Bacteriostatic water is the most commonly used solvent, since its small amount of benzyl alcohol helps inhibit bacterial growth across multiple uses from the same vial.",
      "The solvent is typically added slowly, directed along the inside wall of the vial rather than straight onto the lyophilized powder, and the vial is gently swirled rather than shaken — vigorous agitation can create excess foam or, in some cases, contribute to degradation."
    ] },
    { h2: "Common Mistakes to Avoid", body: [
      "Adding solvent too quickly or in the wrong volume is one of the most common sources of concentration errors, which is why double-checking the calculation against the vial's labeled content before starting is worth the extra step.",
      "Reconstituted solution that isn't used should be stored according to the manufacturer's guidance rather than assumed to remain stable indefinitely — reconstitution starts the clock on a much shorter usable window than the lyophilized powder had."
    ] }
  ], bullets: { heading: "Reconstitution Basics", items: [
    "Calculate the correct solvent volume for the target concentration",
    "Add solvent slowly along the vial wall",
    "Swirl gently — avoid shaking",
    "Refrigerate and use within the recommended window"
  ] } },
  { term: "Research Peptides", def: "Peptides manufactured and sold strictly for laboratory research use, not for human or animal consumption.", sections: [
    { h2: "What Research Peptides Are", body: [
      "Research peptides are peptides manufactured and sold strictly for laboratory research use — for qualified researchers in controlled settings, not for human or animal consumption.",
      "This distinction shapes everything from how a product is labeled to what testing and documentation accompanies it. Research peptides are typically supplied with a Certificate of Analysis so the receiving lab can independently confirm what they've received before it's used in a study."
    ] },
    { h2: "How Research Peptides Differ From Consumer Products", body: [
      "Research peptides are manufactured, labeled, and sold under a different regulatory framework than consumer health products. They're not evaluated by regulatory bodies for safety or efficacy in humans, and reputable suppliers label them clearly as being for laboratory research use only — not for human or animal consumption.",
      "This distinction affects everything from packaging to documentation: research peptides are typically accompanied by testing documentation intended for a laboratory audience, such as a Certificate of Analysis, rather than the consumer-facing labeling required of regulated health products."
    ] },
    { h2: "What Responsible Sourcing Looks Like", body: [
      "Because research peptides aren't subject to the same oversight as approved pharmaceuticals, the burden of verifying quality falls more heavily on documentation and testing transparency. A responsible supplier provides batch-specific Certificates of Analysis, clearly labels products as research use only, and is transparent about its testing methods and facilities.",
      "Researchers evaluating a source are generally well served by treating documentation as a baseline expectation rather than an added bonus — a supplier unwilling or unable to provide batch-specific testing results is a signal worth taking seriously."
    ] }
  ], bullets: { heading: "What to Expect From a Responsible Supplier", items: [
    "Clear \"For Research Use Only\" labeling",
    "Batch-specific Certificates of Analysis",
    "Transparency about testing methods and facilities",
    "Manufacturing aligned with GMP practices"
  ] } },
  { term: "What Is a Peptide?", def: "A short chain of amino acids linked by peptide bonds — smaller than a protein, but built from the same molecular building blocks.", sections: [
    { h2: "The Basic Definition", body: [
      "A peptide is a short chain of amino acids linked together by peptide bonds — the same type of chemical bond, and often the same amino acid building blocks, that make up much larger proteins.",
      "What separates a peptide from a protein is mainly length and structural complexity: peptides are shorter and typically don't fold into the elaborate three-dimensional structures that define most proteins. Because of their smaller size, peptides are often easier to synthesize with precision, which is part of why they're widely used in research."
    ] },
    { h2: "How Peptides Are Built", body: [
      "Every peptide starts with amino acids — of which 20 occur naturally and commonly appear in biological systems — linked end to end through peptide bonds. The specific sequence and combination of amino acids used determines the resulting peptide's identity, size, and behavior.",
      "Peptides can range from just two linked amino acids up to chains of several dozen, with the general (though not strictly defined) convention placing the upper boundary of a 'peptide' at around 50 residues before a chain is more commonly described as a protein."
    ] },
    { h2: "Why Peptides Are Widely Studied", body: [
      "Peptides occupy a useful middle ground for research: they're often more targeted in their biological activity than a small-molecule compound, while being simpler and more practical to synthesize than a full protein. This combination is part of why peptide research spans such a wide range of biological processes and areas of study.",
      "Their relatively small size also makes them more approachable to characterize fully — confirming a peptide's exact sequence, purity, and identity is generally more straightforward than doing the same for a large, complexly folded protein."
    ] }
  ], bullets: { heading: "Peptides at a Glance", items: [
    "Short chains of amino acids linked by peptide bonds",
    "Built from the same 20 common amino acids as proteins",
    "Generally under ~50 amino acids in length",
    "Simpler to synthesize and characterize than most proteins"
  ] } }
];
function glossarySearchIndex(t) { return (t.term + " " + t.def).toLowerCase(); }
function glossarySlug(term) { return term.toLowerCase().replace(/[()]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function glossaryTruncate(str, n) { return str.length > n ? str.slice(0, n).replace(/\s+\S*$/, "") + "…" : str; }
function glossaryListHTML(query) {
  const q = (query || "").trim().toLowerCase();
  const filtered = q ? GLOSSARY_TERMS.filter((t) => glossarySearchIndex(t).includes(q)) : GLOSSARY_TERMS;
  if (!filtered.length) return `<p class="glossary-empty">No terms match “${esc(query)}.” Try a different search.</p>`;
  const sorted = [...filtered].sort((a, b) => a.term.localeCompare(b.term));
  const groups = [];
  sorted.forEach((t) => {
    const letter = t.term.replace(/^(the|a|an)\s+/i, "")[0].toUpperCase();
    let group = groups.find((g) => g.letter === letter);
    if (!group) { group = { letter, items: [] }; groups.push(group); }
    group.items.push(t);
  });
  return groups.map((g) => `
    <div class="glossary-group">
      <span class="glossary-letter mono">${g.letter}</span>
      <dl class="glossary-terms">
        ${g.items.map((t) => `<div class="glossary-entry" id="gt-${glossarySlug(t.term)}"><dt><a href="#/glossary/${glossarySlug(t.term)}">${esc(t.term)}</a></dt><dd>${esc(t.def)}</dd></div>`).join("")}
      </dl>
    </div>`).join("");
}
const GLOSSARY_FEATURED = "Peptide Purity";
const GLOSSARY_CARD_ICONS = [ICONS.flask, ICONS.purity, ICONS.testing, ICONS.lock, ICONS.snow, ICONS.clock];
function glossarySidebarHTML(activeSlug) {
  const sorted = [...GLOSSARY_TERMS].sort((a, b) => a.term.localeCompare(b.term));
  return sorted.map((t) => {
    const slug = glossarySlug(t.term);
    return `<a href="#/glossary/${slug}"${slug === activeSlug ? ' class="active"' : ""}>${esc(t.term)}</a>`;
  }).join("");
}
function glossaryFeaturedHTML() {
  const t = GLOSSARY_TERMS.find((x) => x.term === GLOSSARY_FEATURED) || GLOSSARY_TERMS[0];
  return `
  <a class="glossary-featured" href="#/glossary/${glossarySlug(t.term)}">
    <div class="glossary-featured-media">
      <img src="/images/glossary-featured-selank.jpg" alt="">
    </div>
    <div class="glossary-featured-copy">
      <span class="eyebrow">Peptide Information</span>
      <h2>${esc(t.term)}</h2>
      <p>${esc(t.def)}</p>
      <span class="glossary-featured-link">Read the full definition ${ICONS.arrowRight}</span>
    </div>
  </a>`;
}
function glossaryGridHTML() {
  const rest = GLOSSARY_TERMS.filter((t) => t.term !== GLOSSARY_FEATURED);
  return `<div class="glossary-grid">${rest.map((t, i) => `
    <a class="glossary-card" href="#/glossary/${glossarySlug(t.term)}">
      <div>
        <h3>${esc(t.term)}</h3>
      </div>
    </a>`).join("")}</div>`;
}
function glossaryRelatedHTML(currentTerm) {
  const sorted = [...GLOSSARY_TERMS].sort((a, b) => a.term.localeCompare(b.term));
  const idx = sorted.findIndex((t) => t.term === currentTerm);
  const related = [];
  for (let i = 1; related.length < 3 && i <= sorted.length; i++) {
    related.push(sorted[(idx + i) % sorted.length]);
  }
  return `<div class="glossary-grid">${related.map((t, i) => `
    <a class="glossary-card" href="#/glossary/${glossarySlug(t.term)}">
      <div>
        <h3>${esc(t.term)}</h3>
      </div>
    </a>`).join("")}</div>`;
}
function viewGlossaryTerm(slug) {
  const t = GLOSSARY_TERMS.find((x) => glossarySlug(x.term) === slug);
  if (!t) return viewGlossary();
  return `
  <div class="page-hero info-hero"><div class="wrap">
    <span class="eyebrow">Peptide Information</span>
    <h1>${esc(t.term)}</h1>
    <p class="glossary-byline">By the HoopBioPharma Research Team</p>
    <p class="lede">${esc(t.def)}</p>
  </div></div>
  <section class="tight"><div class="wrap">
    <div class="glossary-term-body">
      <div class="glossary-notice">
        <span class="glossary-notice-label">Notice</span>
        <p>This entry is provided for general research reference only. It is not a protocol, a safety data sheet, or medical guidance, and it does not replace the Certificate of Analysis issued for a specific batch. All compounds referenced are sold strictly for laboratory research use — not for human or animal consumption.</p>
      </div>
      ${t.sections.map((sec) => `
      <h2>${esc(sec.h2)}</h2>
      ${sec.body.map((p) => `<p>${esc(p)}</p>`).join("")}`).join("")}
      ${t.bullets ? `
      <h2>${esc(t.bullets.heading)}</h2>
      <ul class="glossary-term-list">
        ${t.bullets.items.map((item) => `<li>${esc(item)}</li>`).join("")}
      </ul>` : ""}
    </div>
  </div></section>
  <section class="about-grid-section">
    <div class="wrap"><div class="about-cta"><a href="#/coa" class="btn btn-primary">View Certificates of Analysis</a></div></div>
  </section>`;
}
function viewGlossary() {
  return `
  <section class="tight"><div class="wrap">
    <div class="glossary-hub">
      <nav class="glossary-sidebar" aria-label="Glossary terms">${glossarySidebarHTML()}</nav>
      <div class="glossary-main">
        ${glossaryFeaturedHTML()}
        ${glossaryGridHTML()}
      </div>
    </div>
  </div></section>
  <section class="about-grid-section" style="padding-top:0;">
    <div class="wrap"><div class="about-cta"><a href="#/coa" class="btn btn-primary">View Certificates of Analysis</a></div></div>
  </section>`;
}

/* ---- Sign In / Create Account modal — same overlay/card treatment as the entry gate ---- */
function signinModalHTML(mode, mandatory) {
  const isSignup = mode === "signup";
  return `
  <div class="gate-overlay auth-modal-overlay" id="signinOverlay" role="dialog" aria-modal="true" aria-labelledby="signinTitle">
    <div class="gate-card auth-modal-card">
      ${mandatory ? "" : `<button type="button" class="auth-modal-close" id="signinClose" aria-label="Close">${ICONS.close}</button>`}
      <div class="gate-logo"><img src="/images/logo-hoopbiopharma-signin.png" alt="HoopBioPharma" class="gate-logo-full"></div>
      <span class="eyebrow gate-eyebrow">Account</span>
      <h2 class="gate-title" id="signinTitle">${isSignup ? "Create Account" : "Sign In"}</h2>
      <p class="gate-lede">${mandatory
        ? (isSignup
          ? "Create an account to enter the store — it saves your pricing tier so you don't have to pick it every visit."
          : "Sign in to enter the store, or create an account below if you're new here.")
        : (isSignup
          ? "Create an account to save order history, research protocols, and your pricing tier."
          : "Sign in to view order history, saved research protocols, and your account's pricing tier.")}</p>
      <form id="signinForm" novalidate>
        <div class="auth-field">
          <label for="signinEmail">Email address</label>
          <input type="email" id="signinEmail" placeholder="Email address" required autocomplete="email">
        </div>
        <div class="auth-field">
          <label for="signinPassword">Password</label>
          <div class="auth-password-wrap">
            <input type="password" id="signinPassword" placeholder="••••••••" required autocomplete="${isSignup ? "new-password" : "current-password"}">
            <button type="button" class="auth-password-toggle" id="signinPasswordToggle" aria-label="Show password" aria-pressed="false">${ICONS.eye}</button>
          </div>
        </div>
        ${isSignup ? `
        <div class="auth-field">
          <label for="signinConfirmPassword">Confirm password</label>
          <div class="auth-password-wrap">
            <input type="password" id="signinConfirmPassword" placeholder="••••••••" required autocomplete="new-password">
            <button type="button" class="auth-password-toggle" id="signinConfirmPasswordToggle" aria-label="Show password" aria-pressed="false">${ICONS.eye}</button>
          </div>
        </div>` : ""}
        <p class="auth-error" id="signinAuthError" hidden></p>
        <button type="submit" class="btn btn-primary btn-block auth-submit" id="signinSubmit">${isSignup ? "Create Account" : "Sign In"}</button>
      </form>
      <p class="auth-note"><button type="button" id="signinToggleMode">${isSignup ? "Already have an account? Sign in" : "Create an account →"}</button></p>
    </div>
  </div>`;
}

// Turns a Supabase auth error into a short, human-readable message —
// the raw error text is API-internal wording not meant for shoppers.
function authErrorMessage(err) {
  const msg = (err && err.message) || "";
  if (/already registered|already exists|user_already_exists/i.test(msg)) return "An account with that email already exists.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email before signing in — check your inbox.";
  if (/password should be at least|password.*characters/i.test(msg)) return "Password must be at least 6 characters.";
  if (/rate limit/i.test(msg)) return "Too many attempts — please wait a moment and try again.";
  if (/failed to fetch|network|tunnel/i.test(msg)) return "Couldn't reach the server — check your connection and try again.";
  return msg || "Something went wrong. Please try again.";
}

function wirePasswordToggle(inputId, toggleId) {
  const input = document.getElementById(inputId);
  const toggle = document.getElementById(toggleId);
  if (!input || !toggle) return;
  toggle.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    toggle.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
    toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    toggle.setAttribute("aria-pressed", String(!showing));
  });
}

function openSigninModal(mode = "signin", mandatory = false) {
  const mount = document.getElementById("signinModal");
  if (!mount) return;
  mount.innerHTML = signinModalHTML(mode, mandatory);
  document.body.classList.add("gate-locked");

  const overlay = document.getElementById("signinOverlay");
  const close = () => {
    overlay.classList.add("closing");
    document.body.classList.remove("gate-locked");
    setTimeout(() => { mount.innerHTML = ""; }, 200);
  };
  const closeBtn = document.getElementById("signinClose");
  if (closeBtn) closeBtn.addEventListener("click", close);
  document.getElementById("signinToggleMode").addEventListener("click", () => {
    openSigninModal(mode === "signup" ? "signin" : "signup", mandatory);
  });
  if (!mandatory) overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  wirePasswordToggle("signinPassword", "signinPasswordToggle");
  wirePasswordToggle("signinConfirmPassword", "signinConfirmPasswordToggle");

  document.getElementById("signinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    // start the brand voiceover right on this "enter the site" action —
    // a direct synchronous play() inside a real click/submit handler is
    // honored by every browser's autoplay policy, no exceptions.
    document.getElementById("brandVoiceover")?.play().catch(() => {});
    const errorEl = document.getElementById("signinAuthError");
    const submitBtn = document.getElementById("signinSubmit");
    const email = document.getElementById("signinEmail").value.trim();
    const pw = document.getElementById("signinPassword").value;
    errorEl.hidden = true;

    if (mode === "signup") {
      const confirmPw = document.getElementById("signinConfirmPassword").value;
      if (pw !== confirmPw) {
        errorEl.textContent = "Passwords don't match";
        errorEl.hidden = false;
        document.getElementById("signinConfirmPassword").focus();
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = mode === "signup" ? "Creating account…" : "Signing in…";

    let data, error;
    try {
      const result = mode === "signup"
        ? await supabase.auth.signUp({ email, password: pw })
        : await supabase.auth.signInWithPassword({ email, password: pw });
      data = result.data;
      error = result.error;
    } catch (err) {
      error = err;
    }

    if (error) {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "signup" ? "Create Account" : "Sign In";
      errorEl.textContent = authErrorMessage(error);
      errorEl.hidden = false;
      return;
    }

    currentUser = data.session ? data.session.user : (data.user || null);

    if (mode === "signup") {
      close();
      if (!data.session) {
        // Email confirmation is required — no session yet, so there's
        // nothing to pick a tier for until they confirm and sign in.
        showToast("Account created — check your email to confirm before signing in");
        return;
      }
      showToast("Account created");
      window.location.hash = "#/";
      setTimeout(() => { initAgeGate(); }, 400);
    } else {
      close();
      const savedTier = currentUser && currentUser.user_metadata && currentUser.user_metadata.tier;
      if (savedTier && CUSTOMER_TIERS[savedTier]) {
        customerType = savedTier;
        window.location.hash = "#/";
        navigate();
        renderCartDrawer();
        showToast("Signed in");
      } else {
        showToast("Signed in");
        window.location.hash = "#/";
        setTimeout(() => { initAgeGate(); }, 400);
      }
    }
  });
}

/* ---- Wholesale application: 5-step wizard ----
   No backend is wired up, so the final step hands the whole
   application to a mailto: link addressed to the team, same
   pattern used at checkout and the old single-step inquiry form. */
const WSAPP_STEP_TITLES = ["Business Contact", "Organization Details", "Shipping Address", "Compliance", "Review & Submit"];
function wireWholesaleApp() {
  const scrollBtn = document.getElementById("wholesaleScrollBtn");
  if (scrollBtn) {
    scrollBtn.addEventListener("click", () => {
      document.getElementById("wholesaleForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const form = document.getElementById("wholesaleAppForm");
  if (!form) return;
  const steps = Array.from(form.querySelectorAll(".wsapp-step"));
  const backBtn = document.getElementById("wsappBack");
  const nextBtn = document.getElementById("wsappNext");
  const stepLabel = document.getElementById("wsappStepLabel");
  const stepPct = document.getElementById("wsappStepPct");
  const progressFill = document.getElementById("wsappProgressFill");
  let current = 1;

  function fieldVal(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  function renderReview() {
    const rows = [
      ["Business name", fieldVal("wsBusiness")],
      ["Contact", `${fieldVal("wsContactName")} · ${fieldVal("wsEmail")} · ${fieldVal("wsPhone")}`],
      ["Website", fieldVal("wsWebsite") || "—"],
      ["Organization type", fieldVal("wsType")],
      ["Estimated monthly volume", fieldVal("wsVolume")],
      ["Shipping address", `${fieldVal("wsAddress")}, ${fieldVal("wsCity")}, ${fieldVal("wsState")} ${fieldVal("wsZip")}, ${fieldVal("wsCountry")}`]
    ];
    const el = document.getElementById("wsappReview");
    if (el) {
      el.innerHTML = rows.map(([k, v]) => `<div class="wsapp-review-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    }
  }

  function updateChrome() {
    steps.forEach((s) => { s.hidden = Number(s.getAttribute("data-step")) !== current; });
    backBtn.hidden = current === 1;
    nextBtn.textContent = current === steps.length ? "Submit Application" : "Next";
    stepLabel.textContent = `Step ${current} of ${steps.length}`;
    stepPct.textContent = `${Math.round((current / steps.length) * 100)}%`;
    progressFill.style.width = `${(current / steps.length) * 100}%`;
    if (current === steps.length) renderReview();
    updateNextEnabled();
  }

  function updateNextEnabled() {
    const activeStep = steps[current - 1];
    const requiredFields = activeStep.querySelectorAll("[required]");
    const allValid = Array.from(requiredFields).every((f) => f.checkValidity());
    nextBtn.disabled = !allValid;
  }

  form.addEventListener("input", updateNextEnabled);
  form.addEventListener("change", updateNextEnabled);

  backBtn.addEventListener("click", () => {
    if (current > 1) { current -= 1; updateChrome(); }
  });

  nextBtn.addEventListener("click", () => {
    const activeStep = steps[current - 1];
    const requiredFields = activeStep.querySelectorAll("[required]");
    const allValid = Array.from(requiredFields).every((f) => f.checkValidity());
    if (!allValid) {
      requiredFields.forEach((f) => { if (!f.checkValidity()) f.reportValidity(); });
      return;
    }
    if (current < steps.length) {
      current += 1;
      updateChrome();
      return;
    }
    const body =
      `Business name: ${fieldVal("wsBusiness")}\n` +
      `Contact name: ${fieldVal("wsContactName")}\n` +
      `Business email: ${fieldVal("wsEmail")}\n` +
      `Phone number: ${fieldVal("wsPhone")}\n` +
      `Website: ${fieldVal("wsWebsite") || "—"}\n\n` +
      `Organization type: ${fieldVal("wsType")}\n` +
      `Estimated monthly volume: ${fieldVal("wsVolume")}\n` +
      `Shipping address:\n${fieldVal("wsAddress")}\n${fieldVal("wsCity")}, ${fieldVal("wsState")} ${fieldVal("wsZip")}\n${fieldVal("wsCountry")}`;
    window.location.href = `mailto:Info@hoopbiopharma.com?subject=${encodeURIComponent("Wholesale application — " + fieldVal("wsBusiness"))}&body=${encodeURIComponent(body)}`;
    showToast("Application submitted — we'll reply within 1–2 business days");
    form.reset();
    current = 1;
    updateChrome();
  });

  updateChrome();
}

/* try to autoplay the homepage voiceover; browsers block sound-on autoplay
   without a user gesture, so if the direct attempt is blocked, arm a
   one-time listener that starts it on the visitor's first interaction */
let voiceoverUnlockArmed = [];
function armVoiceoverAutoplay(audio, toggle) {
  voiceoverUnlockArmed.forEach(({ evt, fn }) => document.removeEventListener(evt, fn, true));
  voiceoverUnlockArmed = [];

  const tryStart = () => audio.play().catch(() => {});
  tryStart();

  const unlock = () => {
    if (toggle.getAttribute("aria-pressed") === "true" && audio.paused) tryStart();
  };
  ["pointerdown", "touchstart", "keydown", "click"].forEach((evt) => {
    document.addEventListener(evt, unlock, { once: true, capture: true, passive: true });
    voiceoverUnlockArmed.push({ evt, fn: unlock });
  });
}

/* =========================================================
   EVENT WIRING (delegated, re-bound per render)
   ========================================================= */
function wireDynamic() {
  const app = document.getElementById("app");

  wireBuyButtonsWithin(app);
  wireStackSpotlight();
  wireProductPane();
  wireComparePane();

  const brandAudio = document.getElementById("brandVoiceover");
  const soundToggle = document.querySelector("[data-sound-toggle]");
  if (brandAudio && soundToggle) armVoiceoverAutoplay(brandAudio, soundToggle);

  const chips = app.querySelector("#catChips");
  if (chips) {
    chips.querySelectorAll("[data-catchip]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const q = parseHash().query;
        const cat = chip.getAttribute("data-catchip");
        if (cat) q.cat = cat;
        else delete q.cat;
        location.hash = "#/shop" + queryString(q);
      });
    });
  }
  const sortSel = app.querySelector("#sortSelect");
  if (sortSel) {
    sortSel.addEventListener("change", () => {
      const q = parseHash().query;
      q.sort = sortSel.value;
      location.hash = "#/shop" + queryString(q);
    });
  }

  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    const q0 = parseHash().query;
    if (q0.q) searchInput.value = q0.q;
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = parseHash().query;
        q.q = searchInput.value;
        if (!q.q) delete q.q;
        location.hash = "#/shop" + queryString(q);
        closeSearchPanel();
      } else if (e.key === "Escape") {
        closeSearchPanel();
      }
    });
  }

  const searchToggle = document.getElementById("searchToggle");
  const searchPanel = document.getElementById("searchPanel");
  const searchClose = document.getElementById("searchClose");
  if (searchToggle && searchPanel) {
    searchToggle.addEventListener("click", () => {
      const opening = searchPanel.hidden;
      searchPanel.hidden = !opening;
      searchToggle.setAttribute("aria-expanded", String(opening));
      if (opening) {
        const inp = document.getElementById("searchInput");
        if (inp) inp.focus();
      }
    });
  }
  if (searchClose) searchClose.addEventListener("click", closeSearchPanel);

  const coaSearchInput = document.getElementById("coaSearchInput");
  const coaList = document.getElementById("coaList");
  if (coaSearchInput && coaList) {
    coaSearchInput.addEventListener("input", () => {
      coaList.innerHTML = coaRowsHTML(coaSearchInput.value);
    });
  }

  const faqList = app.querySelector(".faq-list");
  if (faqList) {
    faqList.querySelectorAll("[data-faqtoggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".faq-row");
        const wasOpen = row.classList.contains("open");
        faqList.querySelectorAll(".faq-row.open").forEach((r) => {
          r.classList.remove("open");
          r.querySelector("[data-faqtoggle]").setAttribute("aria-expanded", "false");
        });
        if (!wasOpen) {
          row.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
        }
      });
    });
  }
  const faqChatBtn = document.getElementById("faqChatBtn");
  if (faqChatBtn) {
    faqChatBtn.addEventListener("click", () => {
      const fab = document.getElementById("chatFab");
      if (fab) fab.click();
    });
  }

  const qvTabs = document.getElementById("qvTabs");
  const qvPanelCopy = document.getElementById("qvPanelCopy");
  if (qvTabs && qvPanelCopy) {
    qvTabs.querySelectorAll("[data-qvtab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-qvtab");
        qvTabs.querySelectorAll(".qv-tab").forEach((b) => b.classList.toggle("active", b === btn));
        qvPanelCopy.innerHTML = qvPanelHTML(key);
      });
    });
  }

  wireCheckoutPage();
  wireGalleryPage();
  wireAdminPage();
  wireAdminOrdersPage();
  wireAdminPromoCodesPage();

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      document.getElementById("accountMenuWrap").classList.remove("open");
      await supabase.auth.signOut();
      currentUser = null;
      window.location.hash = "#/";
      enterSiteFlow();
    });
  }
  const signinTrigger = document.getElementById("signinTrigger");
  if (signinTrigger) {
    signinTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("accountMenuWrap").classList.remove("open");
      openSigninModal();
    });
  }
  const accountBtn = document.getElementById("accountBtn");
  const accountMenuWrap = document.getElementById("accountMenuWrap");
  if (accountBtn && accountMenuWrap) {
    accountBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      accountMenuWrap.classList.toggle("open");
    });
  }

  const contactForm = document.getElementById("contactForm");
  if (contactForm) {
    contactForm.addEventListener("submit", (e) => {
      e.preventDefault();
      showToast("Message received — we'll reply within 1–2 business days");
      contactForm.reset();
    });
  }

  const newsletterForm = document.getElementById("newsletterForm");
  if (newsletterForm) {
    newsletterForm.addEventListener("submit", (e) => {
      e.preventDefault();
      showToast("You're on the list");
      newsletterForm.reset();
    });
  }

  wireWholesaleApp();

  const navToggle = document.getElementById("navToggle");
  const primaryNav = document.getElementById("primaryNav");
  if (navToggle) navToggle.addEventListener("click", () => primaryNav.classList.toggle("open"));

  const cartBtn = document.getElementById("cartBtn");
  if (cartBtn) cartBtn.addEventListener("click", openCart);

  renderCartCount();
}

/* cart drawer delegated events (drawer persists across route renders) */
document.addEventListener("click", (e) => {
  const minus = e.target.closest("[data-qtyminus]");
  const plus = e.target.closest("[data-qtyplus]");
  const remove = e.target.closest("[data-remove]");
  const checkout = e.target.closest("#checkoutBtn");
  const social = e.target.closest("[data-social]");
  const official = e.target.closest("[data-official]");
  const infoBtn = e.target.closest("#infoDropdownBtn");
  const infoPanel = document.getElementById("infoDropdownPanel");
  const soundToggle = e.target.closest("[data-sound-toggle]");
  if (soundToggle) {
    const audio = document.getElementById("brandVoiceover");
    const label = soundToggle.querySelector("[data-sound-label]");
    const iconOff = soundToggle.querySelector("[data-icon-off]");
    const iconOn = soundToggle.querySelector("[data-icon-on]");
    if (audio) {
      const turningOn = soundToggle.getAttribute("aria-pressed") !== "true";
      if (turningOn) {
        if (audio.ended) audio.currentTime = 0;
        audio.play().catch(() => showToast("Tap sound again to play the voiceover"));
        soundToggle.setAttribute("aria-pressed", "true");
        soundToggle.setAttribute("aria-label", "Mute brand voiceover");
        if (label) label.textContent = "Sound on";
        if (iconOff) iconOff.hidden = true;
        if (iconOn) iconOn.hidden = false;
      } else {
        audio.pause();
        soundToggle.setAttribute("aria-pressed", "false");
        soundToggle.setAttribute("aria-label", "Play brand voiceover");
        if (label) label.textContent = "Sound off";
        if (iconOff) iconOff.hidden = false;
        if (iconOn) iconOn.hidden = true;
      }
    }
  } else if (infoBtn) {
    const opening = infoPanel.hidden;
    infoPanel.hidden = !opening;
    infoBtn.setAttribute("aria-expanded", String(opening));
    document.getElementById("infoDropdown").classList.toggle("open", opening);
  } else if (infoPanel && !infoPanel.hidden && !e.target.closest("#infoDropdown")) {
    infoPanel.hidden = true;
    document.getElementById("infoDropdownBtn").setAttribute("aria-expanded", "false");
    document.getElementById("infoDropdown").classList.remove("open");
  }
  const accountMenuWrap = document.getElementById("accountMenuWrap");
  if (accountMenuWrap && accountMenuWrap.classList.contains("open") && !e.target.closest("#accountMenuWrap")) {
    accountMenuWrap.classList.remove("open");
  }
  if (minus) {
    const idx = Number(minus.getAttribute("data-qtyminus"));
    const step = tierMOQ() > 1 ? tierMOQ() : 1;
    setQty(idx, Math.max(cart[idx].qty - step, tierMOQ()));
  } else if (plus) {
    const idx = Number(plus.getAttribute("data-qtyplus"));
    const step = tierMOQ() > 1 ? tierMOQ() : 1;
    setQty(idx, cart[idx].qty + step);
  } else if (remove) {
    removeLine(Number(remove.getAttribute("data-remove")));
  } else if (checkout) {
    if (cart.length === 0) return;
    closeCartFn();
    window.location.hash = "#/checkout";
  } else if (social) {
    showToast(social.getAttribute("data-social") + " isn't linked yet");
  } else if (official) {
    showToast(official.getAttribute("data-official") + " page is coming soon");
  }
});

/* reset the sound toggle when the brand voiceover finishes on its own */
document.addEventListener("ended", (e) => {
  if (e.target.id !== "brandVoiceover") return;
  const soundToggle = document.querySelector("[data-sound-toggle]");
  if (!soundToggle) return;
  soundToggle.setAttribute("aria-pressed", "false");
  soundToggle.setAttribute("aria-label", "Play brand voiceover");
  const label = soundToggle.querySelector("[data-sound-label]");
  const iconOff = soundToggle.querySelector("[data-icon-off]");
  const iconOn = soundToggle.querySelector("[data-icon-on]");
  if (label) label.textContent = "Sound off";
  if (iconOff) iconOff.hidden = false;
  if (iconOn) iconOn.hidden = true;
}, true);

/* typed quantity entry in the cart drawer */
document.addEventListener("change", (e) => {
  const input = e.target.closest("[data-qtyinput]");
  if (!input) return;
  const idx = Number(input.getAttribute("data-qtyinput"));
  const moq = tierMOQ();
  let qty = Math.round(Number(input.value));
  if (!Number.isFinite(qty) || qty < moq) qty = moq;
  setQty(idx, qty);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.closest("[data-qtyinput]")) {
    e.preventDefault();
    e.target.blur();
  }
});

document.getElementById("closeCart").addEventListener("click", closeCartFn);
document.getElementById("scrim").addEventListener("click", closeCartFn);

window.addEventListener("hashchange", navigate);
initChatWidget();

// Keep currentUser in sync with Supabase's own session lifecycle (token
// refreshes, sign-outs in another tab, etc.) without forcing a re-render
// on every event — the next navigate() call will pick up the change.
supabase.auth.onAuthStateChange((_event, session) => {
  currentUser = session ? session.user : null;
});

// Decides what gate (if any) stands between a visitor and the storefront:
// signed in with a saved tier -> straight in; signed in with no tier yet ->
// the Doctor/Retail/Wholesaler gate; not signed in -> a mandatory sign-in
// (account required to enter), which itself leads into the tier gate.
function enterSiteFlow() {
  navigate();
  renderCartDrawer();
  if (isAdmin()) {
    // The admin account isn't shopping, so skip the research-use/tier
    // gate entirely and drop straight into the site (Admin Portal is
    // reached from the Account menu).
    if (!CUSTOMER_TIERS[customerType]) customerType = "Wholesaler";
    navigate();
    return;
  }
  const savedTier = currentUser && currentUser.user_metadata && currentUser.user_metadata.tier;
  if (currentUser && savedTier && CUSTOMER_TIERS[savedTier]) {
    customerType = savedTier;
    navigate();
  } else if (currentUser) {
    initAgeGate(customerType);
  } else {
    openSigninModal("signin", true);
  }
}

(async function boot() {
  // Never let a Supabase/network hiccup block the storefront from
  // rendering — fall back to a signed-out view if the session check fails.
  try {
    const { data } = await supabase.auth.getSession();
    currentUser = data.session ? data.session.user : null;
  } catch (err) {
    currentUser = null;
  }
  enterSiteFlow();
})();

/* =========================================================
   AGE / CUSTOMER-TYPE GATE
   Shown on every fresh load (not persisted) ahead of the
   storefront, matching the "research use only" framing used
   throughout the site's disclaimers and legal copy.
   ========================================================= */
function ageGateHTML() {
  return `
  <div class="gate-overlay" id="ageGateOverlay" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
    <div class="gate-card">
      <div class="gate-logo"><img src="/images/logo-hoopbiopharma-signin.png" alt="HoopBioPharma" class="gate-logo-full"></div>
      <span class="eyebrow gate-eyebrow">Age Verification</span>
      <h2 class="gate-title" id="gateTitle">Research use only.</h2>
      <p class="gate-lede">HoopBioPharma supplies research-grade peptides for laboratory use. Nothing sold here is for human or animal consumption, and none of it is approved to diagnose, treat, cure, or prevent any disease.</p>
      <ul class="gate-list">
        <li>Sold for <strong>laboratory research only</strong> — not for human or animal consumption.</li>
        <li>Purity and identity are verified per batch by independent HPLC testing.</li>
        <li>No dosing, medical, or therapeutic guidance is provided anywhere on this site.</li>
      </ul>
      <div class="gate-role">
        <span class="gate-role-label">I am purchasing as a</span>
        <div class="gate-role-options" id="gateRoleOptions">
          <button type="button" class="gate-role-btn" data-role="Doctor">Doctor</button>
          <button type="button" class="gate-role-btn" data-role="Retail Customer">Retail Customer</button>
          <button type="button" class="gate-role-btn" data-role="Wholesaler">Wholesaler</button>
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-block gate-enter" id="gateEnter">I am 21 or older — Enter</button>
      <button type="button" class="gate-leave" id="gateLeave">Leave This Site</button>
      <p class="gate-fine">By entering you confirm you are 21 or older, that you are acquiring these materials for laboratory research, and that you accept our terms. Your answer is not stored — these conditions are asked again on every visit.</p>
      <div class="gate-footlinks">
        <span>Research Use Only</span><span class="sep">·</span>
        <button type="button" data-official="Terms">Terms</button><span class="sep">·</span>
        <button type="button" data-official="Privacy">Privacy</button>
      </div>
    </div>
  </div>`;
}

// presetRole: when a signed-in user already has a saved tier, pre-select
// it so returning users just have to confirm rather than re-pick.
function initAgeGate(presetRole) {
  const mount = document.getElementById("ageGate");
  if (!mount) return;
  mount.innerHTML = ageGateHTML();
  document.body.classList.add("gate-locked");

  const overlay = document.getElementById("ageGateOverlay");
  const enterBtn = document.getElementById("gateEnter");
  let selectedRole = null;

  overlay.querySelectorAll(".gate-role-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".gate-role-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedRole = btn.getAttribute("data-role");
      enterBtn.classList.add("ready");
    });
  });

  if (presetRole && CUSTOMER_TIERS[presetRole]) {
    const presetBtn = overlay.querySelector(`.gate-role-btn[data-role="${presetRole}"]`);
    if (presetBtn) {
      presetBtn.classList.add("active");
      selectedRole = presetRole;
      enterBtn.classList.add("ready");
    }
  }

  enterBtn.addEventListener("click", () => {
    if (!selectedRole) return;
    // same as the sign-in submit — fire on the literal "enter" click.
    document.getElementById("brandVoiceover")?.play().catch(() => {});
    customerType = selectedRole;
    if (currentUser) {
      // Persist the chosen tier to their account; fire-and-forget since
      // it shouldn't block entering the site if the request is slow.
      supabase.auth.updateUser({ data: { tier: selectedRole } }).catch(() => {});
    }
    navigate();
    renderCartDrawer();
    overlay.classList.add("closing");
    document.body.classList.remove("gate-locked");
    setTimeout(() => { mount.innerHTML = ""; }, 220);
  });

  document.getElementById("gateLeave").addEventListener("click", () => {
    window.location.href = "https://www.google.com";
  });
}
