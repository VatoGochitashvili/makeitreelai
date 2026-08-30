// Subscriptions, via Stripe Checkout.
//
// Hosted Checkout on purpose: the customer is redirected to Stripe, enters
// their card there, and comes back. No card details ever reach this server,
// which keeps us out of PCI scope entirely and removes the most dangerous code
// we would otherwise have to write.
//
// Everything here is inert until STRIPE_SECRET_KEY is set, so a deployment
// without billing configured behaves exactly as it did before.

import { Router } from "express";
import Stripe from "stripe";
import { PLANS, planOf, CREDIT_PACKS } from "./plans.js";
import { findUserById, setPlan, addTopUp } from "./auth.js";

const KEY = process.env.STRIPE_SECRET_KEY || "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");

// Price ids come from the Stripe dashboard; one per paid plan.
const PRICE = { creator: process.env.STRIPE_PRICE_CREATOR || "", pro: process.env.STRIPE_PRICE_PRO || "" };
// One-off credit packs. Separate ids because these are payments, not
// subscriptions — buying capacity should never change what someone pays monthly.
const PACK_PRICE = {
  small: process.env.STRIPE_PRICE_PACK_SMALL || "",
  medium: process.env.STRIPE_PRICE_PACK_MEDIUM || "",
  large: process.env.STRIPE_PRICE_PACK_LARGE || "",
};

let stripe = null;
if (KEY) stripe = new Stripe(KEY);

export function billingReady() {
  return !!(stripe && (PRICE.creator || PRICE.pro));
}
export function billingStatus() {
  return {
    ready: billingReady(),
    missing: [
      !KEY && "STRIPE_SECRET_KEY",
      !PRICE.creator && "STRIPE_PRICE_CREATOR",
      !PRICE.pro && "STRIPE_PRICE_PRO",
      !WEBHOOK_SECRET && "STRIPE_WEBHOOK_SECRET",
    ].filter(Boolean),
  };
}

export const billingRouter = Router();

billingRouter.get("/billing/status", (req, res) => res.json(billingStatus()));

// Send the customer to Stripe to pay.
billingRouter.post("/billing/checkout", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  if (!billingReady()) return res.status(503).json({ error: "Billing isn't configured on this server yet." });

  const plan = String(req.body?.plan || "");
  if (!PRICE[plan]) return res.status(400).json({ error: "Pick a paid plan." });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE[plan], quantity: 1 }],
      customer_email: req.user.stripeCustomerId ? undefined : req.user.email,
      customer: req.user.stripeCustomerId || undefined,
      // The webhook is what actually grants the plan; this only tells us which
      // account to grant it to.
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, plan },
      subscription_data: { metadata: { userId: req.user.id, plan } },
      success_url: `${SITE}/account.html?upgraded=1`,
      cancel_url: `${SITE}/account.html?cancelled=1`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("stripe checkout failed:", e.message);
    res.status(502).json({ error: "Couldn't start checkout. Try again in a moment." });
  }
});

// Buying credits. A one-off payment, so the plan is untouched and the credits
// land on the account when the webhook confirms the money arrived.
billingRouter.get("/billing/packs", (req, res) => {
  res.json({ packs: CREDIT_PACKS.map((p) => ({ ...p, available: !!PACK_PRICE[p.id] })) });
});

billingRouter.post("/billing/topup", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const pack = CREDIT_PACKS.find((p) => p.id === req.body?.pack);
  if (!pack) return res.status(400).json({ error: "Pick a credit pack." });
  if (!stripe || !PACK_PRICE[pack.id]) {
    return res.status(503).json({ error: "Credit packs aren't set up on this server yet." });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: PACK_PRICE[pack.id], quantity: 1 }],
      customer: req.user.stripeCustomerId || undefined,
      customer_email: req.user.stripeCustomerId ? undefined : req.user.email,
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, kind: "topup", credits: String(pack.credits) },
      success_url: `${SITE}/account.html?topped_up=${pack.credits}`,
      cancel_url: `${SITE}/account.html`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("stripe topup failed:", e.message);
    res.status(502).json({ error: "Couldn't start checkout." });
  }
});

// Cancelling and changing card details happen in Stripe's own portal, so we
// never build screens for them and never hold the data.
billingRouter.post("/billing/portal", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  if (!billingReady()) return res.status(503).json({ error: "Billing isn't configured on this server yet." });
  if (!req.user.stripeCustomerId) return res.status(400).json({ error: "No subscription on this account yet." });
  try {
    const s = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: `${SITE}/account.html`,
    });
    res.json({ url: s.url });
  } catch (e) {
    console.error("stripe portal failed:", e.message);
    res.status(502).json({ error: "Couldn't open the billing portal." });
  }
});

// Stripe tells us what actually happened. This — not the browser coming back
// from checkout — is what changes a plan: the redirect can be faked, forged or
// simply never arrive if someone closes the tab.
export function stripeWebhook(req, res) {
  if (!stripe || !WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (e) {
    console.error("stripe webhook signature rejected:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const apply = (userId, plan, customerId) => {
    const user = findUserById(userId);
    if (!user) return console.error("stripe webhook: unknown user", userId);
    setPlan(user, plan, customerId);
    console.log(`  billing: ${user.email} → ${plan}`);
  };

  try {
    const o = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const userId = o.metadata?.userId || o.client_reference_id;
        if (o.metadata?.kind === "topup") {
          // Credits, not a plan change — and only once the money is confirmed.
          const user = findUserById(userId);
          const credits = Number(o.metadata?.credits || 0);
          if (user && credits > 0) {
            addTopUp(user, credits);
            console.log(`  billing: ${user.email} +${credits} credits`);
          }
        } else {
          apply(userId, o.metadata?.plan || "creator", o.customer);
        }
        break;
      }
      case "customer.subscription.updated": {
        // Downgrade the moment it stops being paid for, not at some later sweep.
        const live = ["active", "trialing"].includes(o.status);
        apply(o.metadata?.userId, live ? (o.metadata?.plan || "creator") : "free", o.customer);
        break;
      }
      case "customer.subscription.deleted":
        apply(o.metadata?.userId, "free", o.customer);
        break;
    }
  } catch (e) {
    console.error("stripe webhook handling failed:", e.message);
  }
  res.json({ received: true });
}

export const PAID_PLANS = Object.values(PLANS).filter((p) => p.price > 0);
