// Vercel serverless function. Builds a Stripe Checkout Session for the
// cart sent from the browser. Every price and the promo discount are
// re-derived here from src/data/ — nothing sent by the client is trusted
// for money math, only which SKUs/quantities/promo code were picked.
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

const priceIdsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/data/stripePriceIds.json");
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
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Checkout is not configured yet" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: "Your cart is empty" });

    const shipKey = SHIP_METHODS[body.shipMethod] ? body.shipMethod : "priority";
    const ship = SHIP_METHODS[shipKey];

    // Any subscribed item makes this a recurring Checkout Session — the
    // non-subscribed items in the same cart still ride along as one-time
    // charges on the first invoice only (Stripe supports mixing one-time
    // and recurring prices in a single subscription-mode session).
    const mode = items.some((it) => it && it.subscribed) ? "subscription" : "payment";

    const line_items = [];
    for (const raw of items) {
      const p = byId[raw && raw.id];
      const mapping = p && stripePriceIds[p.id];
      const qty = Math.max(1, Math.min(999, Math.floor(Number(raw && raw.qty) || 1)));
      if (!p || !mapping) {
        return res.status(400).json({ error: `Product "${raw && raw.id}" isn't available for checkout` });
      }
      if (raw.subscribed) {
        if (!mapping.recurringPriceId) {
          return res.status(400).json({ error: `"${p.name}" isn't available for subscription yet` });
        }
        line_items.push({ price: mapping.recurringPriceId, quantity: qty });
      } else {
        line_items.push({ price: mapping.priceId, quantity: qty });
      }
    }

    if (mode === "subscription") {
      const shipPriceId = stripePriceIds.__shipping && stripePriceIds.__shipping[shipKey];
      if (!shipPriceId) return res.status(500).json({ error: "Recurring shipping isn't configured yet" });
      line_items.push({ price: shipPriceId, quantity: 1 });
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
    const metadata = {
      promo_code: promoPct ? promoCode : "",
      ship_method: shipKey,
      customer_name: customer.name || "",
      customer_phone: customer.phone || "",
      shipping_address: [customer.address, customer.city, customer.state, customer.zip, customer.country]
        .filter(Boolean)
        .join(", ")
        .slice(0, 480),
    };

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items,
      discounts,
      customer_email: customer.email || undefined,
      phone_number_collection: { enabled: true },
      // Subscription mode bills shipping every renewal as its own recurring
      // line item (pushed onto line_items above) instead of a one-time
      // shipping_options rate, which only applies to the first invoice.
      shipping_options: mode === "payment" ? [
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
      ] : undefined,
      metadata,
      subscription_data: mode === "subscription" ? { metadata } : undefined,
      success_url: `${origin}/#/order-confirmation?session_id={CHECKOUT_SESSION_ID}&mode=${mode}`,
      cancel_url: `${origin}/#/checkout`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "Could not start checkout — please try again" });
  }
}
