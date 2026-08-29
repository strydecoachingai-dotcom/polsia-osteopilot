// Production server: real pre-order flow.
// POST /api/pre-order -> Neon DB -> Stripe TEST Checkout -> Resend email -> return URL
"use strict";
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const Stripe = require("stripe");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.RENDER_EXTERNAL_URL || "https://polsia-osteopilot.onrender.com";

// ── Clients
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

// ── DB bootstrap: ensure pre_orders table exists
async function ensureTable() {
  if (!db) return;
  await db.query(`CREATE TABLE IF NOT EXISTS pre_orders (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'beta_monthly',
    stripe_session_id TEXT,
    stripe_url TEXT,
    email_sent BOOLEAN DEFAULT FALSE,
    email_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}
ensureTable().catch(e => console.error("[db]", e.message));

// ── Middleware
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Analytics beacon
app.use((req, res, next) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG;
  const beacon = process.env.POLSIA_BEACON_URL;
  if (slug && beacon) {
    const orig = res.send.bind(res);
    res.send = (body) => {
      if (typeof body === "string" && body.includes("</body>")) {
        body = body.replace("</body>",
          `<script>(function(){try{var v=localStorage.getItem('_pv');if(!v){v=(self.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());localStorage.setItem('_pv',v);}new Image().src="${beacon}/api/beacon/pixel?s=${slug}&v="+v+"&p="+encodeURIComponent(location.pathname);}catch(e){}})();</script></body>`);
      }
      return orig(body);
    };
  }
  next();
});

// ── Routes
app.get("/health", (_req, res) => res.json({ status: "healthy", db: !!db, stripe: !!stripe, resend: !!resend }));
app.get("/", (_req, res) => res.render("layout"));
app.get("/success", (req, res) => res.render("success", { sessionId: req.query.session_id || "" }));
app.get("/checkout", (req, res) => res.render("checkout", { plan: req.query.plan || "beta_monthly" }));

// ── Real pre-order: Neon + Stripe TEST + Resend
app.post("/api/pre-order", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const plan = req.body.plan || "beta_monthly";

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "Email invalide" });
  }

  const amounts = { beta_monthly: 1900, beta_annual: 18000 };
  const labels  = { beta_monthly: "Bêta mensuelle 19€/mois", beta_annual: "Bêta annuelle 180€/an" };
  const amount = amounts[plan] || 1900;
  const label  = labels[plan] || labels.beta_monthly;

  let dbId = null, stripeUrl = null, stripeSessionId = null, emailSent = false, emailId = null;

  // 1. Save to Neon
  try {
    if (db) {
      const r = await db.query("INSERT INTO pre_orders (email, plan) VALUES ($1, $2) RETURNING id", [email, plan]);
      dbId = r.rows[0]?.id;
      console.log(`[DB] inserted id=${dbId} email=${email}`);
    }
  } catch (e) { console.error("[DB]", e.message); }

  // 2. Stripe TEST Checkout Session
  try {
    if (stripe) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
        line_items: [{ price_data: {
          currency: "eur",
          product_data: { name: `OstéoPilot — ${label}`, description: "Accès bêta early-adopter" },
          unit_amount: amount,
        }, quantity: 1 }],
        success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/?cancelled=1`,
        metadata: { plan, email, db_id: String(dbId || "") },
      });
      stripeSessionId = session.id;
      stripeUrl = session.url;
      console.log(`[Stripe] session=${stripeSessionId}`);
      if (db && dbId) {
        await db.query("UPDATE pre_orders SET stripe_session_id=$1, stripe_url=$2 WHERE id=$3",
          [stripeSessionId, stripeUrl, dbId]);
      }
    }
  } catch (e) { console.error("[Stripe]", e.message); }

  // 3. Resend email with Stripe link
  try {
    if (resend && stripeUrl) {
      const r = await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: "Votre lien de précommande OstéoPilot",
        html: `<!DOCTYPE html><html lang="fr"><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<h2>Votre accès bêta OstéoPilot 🎉</h2>
<p>Merci pour votre intérêt ! Votre place early-adopter (<strong>${label}</strong>) est réservée.</p>
<p style="text-align:center;margin:32px 0">
  <a href="${stripeUrl}" style="background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600">
    Finaliser ma précommande →
  </a>
</p>
<p style="color:#666;font-size:13px">Lien : <a href="${stripeUrl}">${stripeUrl.slice(0,80)}</a></p>
<hr><p style="color:#999;font-size:12px">OstéoPilot · Aucun prélèvement tant que la bêta n'est pas confirmée.</p>
</body></html>`,
      });
      emailId = r.data?.id || null;
      emailSent = !!emailId;
      console.log(`[Resend] sent id=${emailId} to=${email}`);
      if (db && dbId) {
        await db.query("UPDATE pre_orders SET email_sent=TRUE, email_id=$1 WHERE id=$2", [emailId, dbId]);
      }
    }
  } catch (e) { console.error("[Resend] error:", e.message, e.statusCode || ""); }

  return res.json({ ok: true, stripeUrl, emailSent, emailId, dbId, plan });
});

// Legacy endpoint
app.post("/api/checkout-intent", (req, res) =>
  res.json({ ok: true, next: "/checkout", plan: req.body.plan || "beta_monthly" }));

app.get("/api/pre-orders", async (_req, res) => {
  if (!db) return res.json({ count: 0, rows: [] });
  try {
    const r = await db.query("SELECT id,email,plan,stripe_session_id,email_sent,created_at FROM pre_orders ORDER BY created_at DESC LIMIT 50");
    return res.json({ count: r.rowCount, rows: r.rows });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`[server] :${PORT}  db=${!!db} stripe=${!!stripe} resend=${!!resend}`);
});

