// Vercel serverless function. Creates a Stripe Customer Portal session so a
// subscriber can view invoices, update their card, or cancel — without
// emailing the team. Looks up the Stripe customer either from a just-completed
// Checkout Session id (right after subscribing) or by email (returning later).
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import Stripe from "stripe";

loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env.local") });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Not configured yet" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const origin = req.headers.origin || `https://${req.headers.host}`;

    let customerId;
    if (body.sessionId) {
      const session = await stripe.checkout.sessions.retrieve(body.sessionId);
      customerId = session.customer;
    } else if (body.email) {
      const customers = await stripe.customers.list({ email: String(body.email).trim(), limit: 1 });
      customerId = customers.data[0] && customers.data[0].id;
    }

    if (!customerId) {
      return res.status(404).json({ error: "No subscription found for that account" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/#/account`,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error("create-portal-session error:", err);
    return res.status(500).json({ error: "Could not open the subscription portal — please try again" });
  }
}
