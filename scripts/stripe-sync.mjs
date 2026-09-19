// Syncs every SKU in src/data/products.js to Stripe as a Product + one-time
// retail Price, and writes the resulting price IDs to
// src/data/stripePriceIds.json (test mode) or src/data/stripePriceIds.live.json
// (live mode), picked automatically from which kind of key is active —
// committed to git so the checkout API can build line items without
// trusting client prices and without needing Stripe access at request time.
// Test and live mode are entirely separate Stripe environments with
// different object IDs, hence two files: whichever one
// api/create-checkout-session.js loads is picked the same way, by the
// live/test-ness of whatever STRIPE_SECRET_KEY is active in that Vercel
// environment (Preview/Development stay on a test key; Production gets the
// live key).
//
// Run this manually whenever src/data/products.js or promoCodes.js change,
// then commit the updated stripePriceIds(.live).json:
//   npm run stripe:sync
//
// NOT wired into `npm run build`: Vercel's build sandbox appears to block
// or heavily throttle outbound calls to third-party APIs (only npm
// installs go through fast), so the ~55 sequential Stripe API calls this
// script makes hang the whole deploy for 10+ minutes there even though
// they take seconds locally. Confirmed 2026-09-19 — don't re-add it to
// the build script without testing a Preview deploy first.
//
// Idempotent: re-running it only touches products whose retail price (or
// name/description) actually changed. Stripe Prices are immutable, so a
// price change retires the old Price (active:false) and creates a new one.
//
// All products are one-time purchases only — no subscriptions/recurring
// billing (removed 2026-09-19 per a change of plans).

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Stripe from "stripe";

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
    console.log(`created  ${p.sku.padEnd(28)} ${p.name}`);
    return { productId: stripeProduct.id, priceId: stripeProduct.default_price, amount };
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

  if (currentPrice && currentPrice.unit_amount === amount && currentPrice.active) {
    console.log(`unchanged ${p.sku.padEnd(27)} ${p.name}`);
    return { productId: stripeProduct.id, priceId: currentPrice.id, amount };
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
  return { productId: stripeProduct.id, priceId: newPrice.id, amount };
}

const existing = await fetchExistingBySku();
const out = {};
for (const p of PRODUCTS) {
  const result = await syncProduct(p, existing);
  out[p.id] = result;
}

const outPath = path.join(ROOT, `src/data/stripePriceIds${isLive ? ".live" : ""}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote ${Object.keys(out).length} price mappings to ${path.relative(ROOT, outPath)}`);

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
