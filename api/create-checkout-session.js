// Vercel serverless function. Builds a Stripe embedded Checkout Session for
// the cart sent from the browser (one-time purchase only, no subscriptions).
// Every price and the promo discount are re-derived here from src/data/ —
// nothing sent by the client is trusted for money math, only which
// SKUs/quantities/promo code were picked.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Stripe from "stripe";
import { byId } from "../src/data/products.js";
import { PROMO_CODES } from "../src/data/promoCodes.js";
import { SHIP_METHODS } from "../src/data/shipping.js";

// In production Vercel injects env vars directly and this file won't exist,
// so this is a silent no-op there — it only matters for `vercel dev` locally.
loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env.local") });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Test and live mode are separate Stripe environments with different object
// IDs, so there are two mapping files — pick whichever matches the active
// key (see scripts/stripe-sync.mjs for how each one gets generated).
const isLive = /_live_/.test(process.env.STRIPE_SECRET_KEY || "");
const priceIdsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../src/data/stripePriceIds${isLive ? ".live" : ""}.json`
);
let stripePriceIds = {};
try {
  stripePriceIds = JSON.parse(readFileSync(priceIdsPath, "utf8"));
} catch {
  // Not synced yet — every item lookup below will 400 until `npm run stripe:sync` runs.
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Checkout is not configured yet" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: "Your cart is empty" });

    const shipKey = SHIP_METHODS[body.shipMethod] ? body.shipMethod : "priority";
    const ship = SHIP_METHODS[shipKey];

    const line_items = [];
    for (const raw of items) {
      const p = byId[raw && raw.id];
      const mapping = p && stripePriceIds[p.id];
      const qty = Math.max(1, Math.min(999, Math.floor(Number(raw && raw.qty) || 1)));
      if (!p || !mapping) {
        return res.status(400).json({ error: `Product "${raw && raw.id}" isn't available for checkout` });
      }
      line_items.push({ price: mapping.priceId, quantity: qty });
    }

    let discounts;
    const promoCode = (body.promoCode || "").toUpperCase().trim();
    const promoPct = promoCode ? PROMO_CODES[promoCode] : null;
    if (promoPct) {
      // Fixed, deterministic coupon id per code (see scripts/stripe-sync.mjs)
      // instead of creating a fresh one-off coupon per checkout attempt.
      discounts = [{ coupon: `promo-${promoCode.toLowerCase()}` }];
    }

    const customer = body.customer || {};
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded_page",
      mode: "payment",
      line_items,
      discounts,
      customer_email: customer.email || undefined,
      phone_number_collection: { enabled: true },
      // Matches the site's own checkout panel so the embedded iframe reads
      // as part of the page instead of a boxed-in third-party widget — an
      // iframe can't be styled with our own CSS (same-origin policy), this
      // is the only supported way to blend it in.
      branding_settings: {
        background_color: "#eff1f6",
        button_color: "#102447",
        border_style: "rounded",
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: Math.round(ship.price * 100), currency: "usd" },
            display_name: ship.label,
            delivery_estimate: {
              minimum: { unit: "business_day", value: shipKey === "overnight" ? 1 : 2 },
              maximum: { unit: "business_day", value: shipKey === "overnight" ? 1 : 3 },
            },
          },
        },
      ],
      metadata: {
        promo_code: promoPct ? promoCode : "",
        ship_method: shipKey,
        customer_name: customer.name || "",
        customer_phone: customer.phone || "",
        shipping_address: [customer.address, customer.city, customer.state, customer.zip, customer.country]
          .filter(Boolean)
          .join(", ")
          .slice(0, 480),
      },
      return_url: `${origin}/#/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
    });

    return res.status(200).json({ clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "Could not start checkout — please try again" });
  }
}
