// Syncs every SKU in src/data/products.js to Stripe as a Product + retail
// Price (+ a monthly recurring Price for "subscribe & save"), and writes
// the resulting price IDs to src/data/stripePriceIds.json (test mode) or
// src/data/stripePriceIds.live.json (live mode), picked automatically from
// which kind of key is active — committed to git so the checkout API can
// build line items without trusting client prices and without needing
// Stripe access at request time. Test and live mode are entirely separate
// Stripe environments with different object IDs, hence two files: whichever
// one api/create-checkout-session.js loads is picked the same way, by the
// live/test-ness of whatever STRIPE_SECRET_KEY is active in that Vercel
// environment (Preview/Development stay on a test key; Production gets the
// live key) — see isLiveKey() below.
//
// Run this manually whenever src/data/products.js, promoCodes.js, or
// shipping.js change, then commit the updated stripePriceIds.json:
//   npm run stripe:sync
//
// NOT wired into `npm run build`: Vercel's build sandbox appears to block
// or heavily throttle outbound calls to third-party APIs (only npm
// installs go through fast), so the ~110 sequential Stripe API calls this
// script makes hang the whole deploy for 10+ minutes there even though
// they take seconds locally. Confirmed 2026-09-19 — don't re-add it to
// the build script without testing a Preview deploy first.
//
// Idempotent: re-running it only touches products whose retail price (or
// name/description) actually changed. Stripe Prices are immutable, so a
// price change retires the old Price (active:false) and creates a new one.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Stripe from "stripe";

// Recurring plan for the "subscribe & save 5%" option — monthly billing,
// shared by every product's subscription Price and by the recurring
// shipping Prices below.
const RECUR_INTERVAL = "month";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(ROOT, ".env.local") });

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set (checked process.env and .env.local). Aborting.");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://hoopbiopharma.com";
const isLive = /_live_/.test(process.env.STRIPE_SECRET_KEY);
console.log(`Syncing in ${isLive ? "LIVE" : "test"} mode\n`);

const { PRODUCTS } = await import(pathToFileURL(path.join(ROOT, "src/data/products.js")));
const { PROMO_CODES } = await import(pathToFileURL(path.join(ROOT, "src/data/promoCodes.js")));
const { SHIP_METHODS } = await import(pathToFileURL(path.join(ROOT, "src/data/shipping.js")));

// Finds the active recurring Price for a product at the given amount, or
// creates one (retiring a stale-amount one first — Prices are immutable).
async function syncRecurringPrice(stripeProduct, amount) {
  const prices = await stripe.prices.list({ product: stripeProduct.id, type: "recurring", active: true, limit: 10 });
  const current = prices.data.find((pr) => pr.recurring && pr.recurring.interval === RECUR_INTERVAL);
  if (current && current.unit_amount === amount) return current.id;

  const created = await stripe.prices.create({
    product: stripeProduct.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: RECUR_INTERVAL }
  });
  if (current) await stripe.prices.update(current.id, { active: false });
  return created.id;
}

async function fetchExistingBySku() {
  const bySku = new Map();
  let startingAfter;
  for (;;) {
    const page = await stripe.products.list({ limit: 100, starting_after: startingAfter, active: undefined });
    for (const prod of page.data) {
      if (prod.metadata && prod.metadata.sku) bySku.set(prod.metadata.sku, prod);
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return bySku;
}

async function syncProduct(p, existing) {
  const amount = Math.round(p.price * 100);
  const recurAmount = Math.round(p.subscribePrice * 100);
  const images = [`${SITE_ORIGIN}${p.image}`];
  const metadata = {
    sku: p.sku,
    catalog_id: p.id,
    category: p.category,
    concentration: p.concentration || ""
  };

  let stripeProduct = existing.get(p.sku);
  if (!stripeProduct) {
    stripeProduct = await stripe.products.create({
      name: p.name,
      description: p.description ? p.description.slice(0, 500) : undefined,
      images,
      metadata,
      default_price_data: {
        currency: "usd",
        unit_amount: amount
      }
    });
    const recurringPriceId = await syncRecurringPrice(stripeProduct, recurAmount);
    console.log(`created  ${p.sku.padEnd(28)} ${p.name}`);
    return { productId: stripeProduct.id, priceId: stripeProduct.default_price, amount, recurringPriceId, recurAmount };
  }

  const needsProductUpdate =
    stripeProduct.name !== p.name ||
    stripeProduct.metadata.catalog_id !== p.id ||
    stripeProduct.metadata.category !== p.category;
  if (needsProductUpdate) {
    stripeProduct = await stripe.products.update(stripeProduct.id, {
      name: p.name,
      description: p.description ? p.description.slice(0, 500) : undefined,
      images,
      metadata
    });
  }

  const currentPrice = stripeProduct.default_price
    ? await stripe.prices.retrieve(stripeProduct.default_price)
    : null;

  const recurringPriceId = await syncRecurringPrice(stripeProduct, recurAmount);

  if (currentPrice && currentPrice.unit_amount === amount && currentPrice.active) {
    console.log(`unchanged ${p.sku.padEnd(27)} ${p.name}`);
    return { productId: stripeProduct.id, priceId: currentPrice.id, amount, recurringPriceId, recurAmount };
  }

  const newPrice = await stripe.prices.create({
    product: stripeProduct.id,
    currency: "usd",
    unit_amount: amount
  });
  await stripe.products.update(stripeProduct.id, { default_price: newPrice.id });
  if (currentPrice && currentPrice.active) {
    await stripe.prices.update(currentPrice.id, { active: false });
  }
  console.log(`repriced ${p.sku.padEnd(28)} ${p.name}  ${currentPrice ? currentPrice.unit_amount / 100 : "?"} -> ${amount / 100}`);
  return { productId: stripeProduct.id, priceId: newPrice.id, amount, recurringPriceId, recurAmount };
}

const existing = await fetchExistingBySku();
const out = {};
for (const p of PRODUCTS) {
  const result = await syncProduct(p, existing);
  out[p.id] = result;
}

// ---------------------------------------------------------------------
// Recurring shipping "products" — one per SHIP_METHODS key, fixed id so
// re-runs update in place. Charged every renewal on a subscription
// checkout instead of the one-time shipping_rate used for normal orders,
// since Checkout Sessions can't mix a one-time shipping_rate into a
// recurring subscription's future invoices.
// ---------------------------------------------------------------------
out.__shipping = {};
for (const [key, info] of Object.entries(SHIP_METHODS)) {
  const productId = `shipping-${key}`;
  const amount = Math.round(info.price * 100);
  let shipProduct;
  try {
    shipProduct = await stripe.products.retrieve(productId);
  } catch {
    shipProduct = null;
  }
  if (!shipProduct) {
    shipProduct = await stripe.products.create({
      id: productId,
      name: `${info.label} (recurring)`,
      default_price_data: { currency: "usd", unit_amount: amount, recurring: { interval: RECUR_INTERVAL } }
    });
    out.__shipping[key] = shipProduct.default_price;
    console.log(`created  shipping/${key.padEnd(19)} ${info.label}`);
    continue;
  }
  const recurringPriceId = await syncRecurringPrice(shipProduct, amount);
  out.__shipping[key] = recurringPriceId;
  console.log(`unchanged shipping/${key.padEnd(18)} ${info.label}`);
}

const outPath = path.join(ROOT, `src/data/stripePriceIds${isLive ? ".live" : ""}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote ${Object.keys(out).length - 1} price mappings + shipping to ${path.relative(ROOT, outPath)}`);

// ---------------------------------------------------------------------
// Promo code coupons — one fixed-id coupon per active code (id: promo-<code
// lowercased>), reused by api/create-checkout-session.js on every request
// instead of creating a new one-off coupon per checkout attempt.
// percent_off is immutable on a Stripe coupon, so a changed percentage
// retires the old id and recreates it fresh.
// ---------------------------------------------------------------------
for (const [code, pct] of Object.entries(PROMO_CODES)) {
  if (!pct) continue;
  const id = `promo-${code.toLowerCase()}`;
  let current;
  try {
    current = await stripe.coupons.retrieve(id);
  } catch {
    current = null;
  }
  if (current && current.percent_off === pct * 100) {
    console.log(`unchanged coupon ${id}`);
    continue;
  }
  if (current) await stripe.coupons.del(id);
  await stripe.coupons.create({ id, percent_off: pct * 100, duration: "once", name: code });
  console.log(`${current ? "repriced" : "created "} coupon ${id} (${pct * 100}% off)`);
}

// ---------------------------------------------------------------------
// Customer Portal default configuration — lets a subscriber cancel or
// update their payment method themselves at a Stripe-hosted URL
// (api/create-portal-session.js). Created once; safe to re-run since we
// look for an existing default configuration first.
// ---------------------------------------------------------------------
const existingConfigs = await stripe.billingPortal.configurations.list({ limit: 100 });
const hasDefault = existingConfigs.data.some((c) => c.is_default);
if (!hasDefault) {
  await stripe.billingPortal.configurations.create({
    business_profile: { headline: "HoopBioPharma — manage your subscription" },
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address", "phone"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false }
    }
  });
  console.log("created  billing portal default configuration");
} else {
  console.log("unchanged billing portal configuration (default already exists)");
}
