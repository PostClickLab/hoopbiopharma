// Vercel serverless function. Stripe calls this when a checkout completes,
// and we mirror the order into the same Supabase `orders` table the admin
// portal writes to manually — so site orders and phone/email orders end up
// in one place. Uses the Supabase service role key (bypasses RLS) since
// there's no signed-in user in a webhook request.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env.local") });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const isLive = /_live_/.test(process.env.STRIPE_SECRET_KEY || "");
const webhookSecret = isLive ? process.env.STRIPE_WEBHOOK_SECRET_LIVE : process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Vercel auto-parses JSON bodies by default, which would corrupt the exact
// byte stream Stripe's signature covers — this endpoint needs the raw body.
export const config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }
  if (!webhookSecret) {
    console.error("stripe-webhook: no signing secret configured for this mode");
    return res.status(500).send("Webhook not configured");
  }

  let event;
  try {
    const rawBody = await buffer(req);
    console.log("DEBUG rawBody length:", rawBody.length, "typeof req.body:", typeof req.body, "isBuffer:", Buffer.isBuffer(req.body));
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], webhookSecret);
  } catch (err) {
    console.error("stripe-webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true, skipped: event.type });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
      expand: ["line_items.data.price.product"],
    });

    const items = session.line_items.data.map((li) => {
      const product = li.price && li.price.product;
      const meta = (product && product.metadata) || {};
      return {
        id: meta.catalog_id || "",
        name: product ? product.name : li.description,
        sku: meta.sku || "",
        qty: li.quantity,
        unitPrice: li.price ? li.price.unit_amount / 100 : 0,
      };
    });

    const md = session.metadata || {};
    // No dedicated "stripe session id" column on this table, so the marker
    // rides along in `notes` — checkout.session.completed can retry/redeliver,
    // and this is what lets a redelivery no-op instead of double-recording
    // the order.
    const sessionMarker = `stripe_session:${session.id}`;
    const notesParts = [md.promo_code ? `Promo code: ${md.promo_code}` : null, sessionMarker].filter(Boolean);

    const payload = {
      customer_name: md.customer_name || (session.customer_details && session.customer_details.name) || "",
      customer_email: session.customer_details ? session.customer_details.email : session.customer_email,
      customer_phone: md.customer_phone || (session.customer_details && session.customer_details.phone) || null,
      shipping_address: {
        street: md.ship_address || "",
        city: md.ship_city || "",
        state: md.ship_state || "",
        zip: md.ship_zip || "",
        country: md.ship_country || "",
      },
      items,
      price_tier: md.price_tier || null,
      shipping_method: md.ship_method || null,
      shipping_cost: session.shipping_cost ? session.shipping_cost.amount_total / 100 : 0,
      subtotal: session.amount_subtotal != null ? session.amount_subtotal / 100 : 0,
      total: session.amount_total != null ? session.amount_total / 100 : 0,
      notes: notesParts.join(" | "),
      created_by: "stripe-checkout",
    };

    const { data: dupe } = await supabase
      .from("orders")
      .select("id")
      .ilike("notes", `%${sessionMarker}%`)
      .maybeSingle();
    if (!dupe) {
      const { error } = await supabase.from("orders").insert(payload);
      if (error) throw error;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("stripe-webhook processing error:", err);
    // Non-2xx makes Stripe retry the event later instead of losing the order.
    return res.status(500).json({ error: "Failed to record order" });
  }
}
