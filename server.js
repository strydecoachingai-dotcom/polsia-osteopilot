// OstéoPilot — single source of truth for production.
// Endpoints: / (landing), POST /api/pre-order (Neon+Stripe+Resend), /api/track (UTM+pageview),
//            /admin/stats (funnel by UTM channel), /api/pre-orders (JSON).
"use strict";
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const Stripe = require("stripe");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.RENDER_EXTERNAL_URL || "https://polsia-osteopilot.onrender.com";

const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

async function ensureTables() {
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS pre_orders (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'beta_monthly',
      stripe_session_id TEXT,
      stripe_url TEXT,
      email_sent BOOLEAN DEFAULT FALSE,
      email_id TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS page_views (
      id SERIAL PRIMARY KEY,
      visitor_id TEXT,
      path TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      referrer TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS demo_consultations (
      id SERIAL PRIMARY KEY,
      patient_id TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      motif TEXT,
      anamnese TEXT,
      tests TEXT,
      traitement TEXT,
      conseils TEXT,
      cr_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS utm_source TEXT;
    ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS utm_medium TEXT;
    ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
    ALTER TABLE pre_orders ADD COLUMN IF NOT EXISTS utm_content TEXT;
  `).catch(() => {});
}
ensureTables().catch(e => console.error("[db bootstrap]", e.message));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Analytics beacon injection.
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
app.get("/health", (_req, res) => res.json({ status: "healthy", db: !!db, stripe: !!stripe, resend: !!resend, version: "v3-utm" }));
app.get("/", (_req, res) => res.render("layout"));
app.get("/success", (req, res) => res.render("success", { sessionId: req.query.session_id || "" }));
app.get("/checkout", (req, res) => res.render("checkout", { plan: req.query.plan || "beta_monthly" }));

// ── UTM tracking endpoint
app.post("/api/track", async (req, res) => {
  const { visitor_id, path: p, utm_source, utm_medium, utm_campaign, utm_content, referrer } = req.body || {};
  try {
    if (db) {
      await db.query(
        "INSERT INTO page_views (visitor_id, path, utm_source, utm_medium, utm_campaign, utm_content, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [visitor_id || null, p || "/", utm_source || null, utm_medium || null, utm_campaign || null, utm_content || null, referrer || null]
      );
    }
  } catch (e) { console.error("[track]", e.message); }
  res.json({ ok: true });
});

// ── Admin stats: funnel by UTM channel
app.get("/admin/stats", async (_req, res) => {
  if (!db) return res.json({ error: "no db" });
  try {
    const [totals] = (await db.query("SELECT COUNT(*) as views FROM page_views")).rows;
    const [signups] = (await db.query("SELECT COUNT(*) as total, COUNT(CASE WHEN email_sent THEN 1 END) as emailed FROM pre_orders")).rows;
    const bySource = (await db.query(`
      SELECT COALESCE(utm_source, 'direct') as source, COUNT(*) as n
      FROM pre_orders GROUP BY source ORDER BY n DESC
    `)).rows;
    const bySourceViews = (await db.query(`
      SELECT COALESCE(utm_source, 'direct') as source, COUNT(*) as n
      FROM page_views GROUP BY source ORDER BY n DESC LIMIT 10
    `)).rows;
    const recent = (await db.query("SELECT email, plan, utm_source, email_sent, created_at FROM pre_orders ORDER BY created_at DESC LIMIT 20")).rows;
    res.json({ page_views: Number(totals.views), signups: Number(signups.total), emailed: Number(signups.emailed), by_source_signups: bySource, by_source_views: bySourceViews, recent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Real pre-order: Neon + Stripe TEST + Resend + UTM
app.post("/api/pre-order", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const plan = req.body.plan || "beta_monthly";
  const { utm_source, utm_medium, utm_campaign, utm_content } = req.body;

  if (!email || !email.includes("@")) return res.status(400).json({ ok: false, error: "Email invalide" });

  const amounts = { beta_monthly: 1900, beta_annual: 18000 };
  const labels  = { beta_monthly: "Bêta mensuelle 19€/mois", beta_annual: "Bêta annuelle 180€/an" };
  const amount = amounts[plan] || 1900;
  const label  = labels[plan] || labels.beta_monthly;

  let dbId = null, stripeUrl = null, stripeSessionId = null, emailSent = false, emailId = null;

  try {
    if (db) {
      const r = await db.query(
        "INSERT INTO pre_orders (email, plan, utm_source, utm_medium, utm_campaign, utm_content) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [email, plan, utm_source || null, utm_medium || null, utm_campaign || null, utm_content || null]
      );
      dbId = r.rows[0]?.id;
      console.log(`[DB] id=${dbId} email=${email} source=${utm_source || "direct"}`);
    }
  } catch (e) { console.error("[DB]", e.message); }

  try {
    if (stripe) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
        line_items: [{ price_data: {
          currency: "eur",
          product_data: { name: `OstéoPilot — ${label}` },
          unit_amount: amount,
        }, quantity: 1 }],
        success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/?cancelled=1`,
        metadata: { plan, email, utm_source: utm_source || "direct", db_id: String(dbId || "") },
      });
      stripeSessionId = session.id;
      stripeUrl = session.url;
      if (db && dbId) await db.query("UPDATE pre_orders SET stripe_session_id=$1, stripe_url=$2 WHERE id=$3", [stripeSessionId, stripeUrl, dbId]);
    }
  } catch (e) { console.error("[Stripe]", e.message); }

  try {
    if (resend && stripeUrl) {
      const r = await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: "Votre lien de précommande OstéoPilot",
        html: `<!DOCTYPE html><html lang="fr"><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<h2>Votre accès bêta OstéoPilot 🎉</h2>
<p>Merci ! Votre place early-adopter (<strong>${label}</strong>) est réservée.</p>
<p style="text-align:center;margin:32px 0"><a href="${stripeUrl}" style="background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600">Finaliser ma précommande →</a></p>
<p style="color:#666;font-size:13px">Ou copiez : <a href="${stripeUrl}">${stripeUrl.slice(0,80)}</a></p>
<hr><p style="color:#999;font-size:12px">OstéoPilot · RGPD · Aucun prélèvement avant confirmation bêta.</p>
</body></html>`,
      });
      emailId = r.data?.id || null;
      emailSent = !!emailId;
      if (emailSent && db && dbId) await db.query("UPDATE pre_orders SET email_sent=TRUE, email_id=$1 WHERE id=$2", [emailId, dbId]);
    }
  } catch (e) { console.error("[Resend] error:", e.message); }

  return res.json({ ok: true, stripeUrl, emailSent, emailId, dbId, plan, source: utm_source || "direct" });
});

app.post("/api/checkout-intent", (req, res) =>
  res.json({ ok: true, next: "/checkout", plan: req.body.plan || "beta_monthly" }));

app.get("/api/pre-orders", async (_req, res) => {
  if (!db) return res.json({ count: 0, rows: [] });
  try {
    const r = await db.query("SELECT id,email,plan,stripe_session_id,email_sent,utm_source,created_at FROM pre_orders ORDER BY created_at DESC LIMIT 50");
    return res.json({ count: r.rowCount, rows: r.rows });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── DEMO — Scribe IA testable ─────────────────────────────────────────────────
// IMPORTANT: Demo data only. No real patient data. Not a medical device.

app.get("/demo", (_req, res) => res.render("demo"));

// Claude API call — generates compte rendu ostéopathique from clinical notes.
app.post("/demo/generate", async (req, res) => {
  const { patient, motif, anamnese, tests, traitement, conseils } = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY not configured" });

  const prompt = `Tu es un assistant pour ostéopathes. Tu génères des comptes rendus de consultation structurés et professionnels à partir des notes cliniques d'un praticien.

DONNÉES DE CONSULTATION (fictives — usage démo uniquement):
- Patient : ${patient?.name || "Patient fictif"} (${patient?.sex || ""}, né(e) le ${patient?.birthDate || ""})
- Motif principal : ${motif || "(non renseigné)"}
- Anamnèse : ${anamnese || "(non renseignée)"}
- Tests ostéopathiques : ${tests || "(non renseignés)"}
- Traitement réalisé : ${traitement || "(non renseigné)"}
- Conseils & suivi : ${conseils || "(non renseignés)"}

Génère un compte rendu de consultation structuré, professionnel et concis (200-350 mots). Utilise le vocabulaire ostéopathique approprié. Structure : Date · Motif · Anamnèse · Examen ostéopathique · Traitement · Conseils · Prochain rendez-vous (si pertinent).

IMPORTANT : Ce compte rendu est généré pour une application de démonstration. L'ostéopathe DOIT le valider, le compléter et l'adapter avant tout usage clinique réel. Ne fais aucun diagnostic médical.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return res.status(500).json({ ok: false, error: `Claude API ${resp.status}: ${err.slice(0, 200)}` });
    }
    const data = await resp.json();
    const cr = data.content?.[0]?.text || "";
    console.log(`[Demo] CR generated for ${patient?.name} (${cr.length} chars)`);
    return res.json({ ok: true, cr });
  } catch (e) {
    console.error("[Demo] Claude error:", String(e));
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Save consultation to Neon DB.
app.post("/demo/save", async (req, res) => {
  const { patient, motif, anamnese, tests, traitement, conseils, cr } = req.body || {};
  try {
    if (db) {
      const r = await db.query(
        "INSERT INTO demo_consultations (patient_id, patient_name, motif, anamnese, tests, traitement, conseils, cr_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [patient?.id || "p_unknown", patient?.name || "Inconnu", motif || null, anamnese || null, tests || null, traitement || null, conseils || null, cr || null]
      );
      console.log(`[Demo] Consultation saved id=${r.rows[0]?.id} patient=${patient?.name}`);
      return res.json({ ok: true, id: r.rows[0]?.id });
    }
    return res.json({ ok: true, id: "demo_no_db" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get consultation history for a demo patient.
app.get("/demo/consultations", async (req, res) => {
  const patientId = req.query.patient_id || "p1";
  try {
    if (!db) return res.json({ rows: [] });
    const r = await db.query(
      "SELECT id, motif, cr_text, created_at FROM demo_consultations WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 20",
      [patientId]
    );
    return res.json({ rows: r.rows });
  } catch (e) {
    return res.status(500).json({ error: String(e), rows: [] });
  }
});

app.listen(PORT, () => console.log(`[server] :${PORT}  db=${!!db} stripe=${!!stripe} resend=${!!resend} demo=true`));
