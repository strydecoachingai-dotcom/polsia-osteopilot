// Express + EJS app. Landing page with paid-beta pricing + tracked pre-order CTA.
// Ships with the analytics beacon + a Postgres-ready shape (DATABASE_URL).
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Analytics beacon — INFRASTRUCTURE, injected into every HTML response.
app.use((req, res, next) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG;
  const beacon = process.env.POLSIA_BEACON_URL;
  if (slug && beacon) {
    const send = res.send.bind(res);
    res.send = (body) => {
      if (typeof body === "string" && body.includes("</body>")) {
        const tag =
          "<script>(function(){try{var v=localStorage.getItem('_pv');" +
          "if(!v){v=(self.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());localStorage.setItem('_pv',v);}" +
          "new Image().src=" + JSON.stringify(beacon) + "+\"/api/beacon/pixel?s=\"+encodeURIComponent(" + JSON.stringify(slug) +
          ")+\"&v=\"+v+\"&p=\"+encodeURIComponent(location.pathname);}catch(e){}})();</script>";
        body = body.replace("</body>", tag + "</body>");
      }
      return send(body);
    };
  }
  next();
});

// --- Willingness-to-pay intent capture -------------------------------------
// Persists pre-order / checkout-intent events to a local JSONL file (append-only)
// so we can measure not just interest but disposition à payer.
const INTENT_LOG = path.join(__dirname, "data", "intents.jsonl");
function logIntent(record) {
  try {
    fs.mkdirSync(path.dirname(INTENT_LOG), { recursive: true });
    fs.appendFileSync(INTENT_LOG, JSON.stringify(record) + "\n");
  } catch (e) {
    console.error("intent log error", e.message);
  }
}

app.get("/health", (_req, res) => res.json({ status: "healthy" }));
app.get("/", (_req, res) => res.render("layout"));

// Tracked click toward checkout — records payment intent.
app.post("/api/checkout-intent", (req, res) => {
  const { plan, email, visitor } = req.body || {};
  const record = {
    ts: new Date().toISOString(),
    event: "checkout_intent",
    plan: plan || "beta_monthly",
    email: (email || "").trim().toLowerCase() || null,
    visitor: visitor || null,
    ua: req.headers["user-agent"] || null,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
  };
  logIntent(record);
  console.log("[checkout_intent]", JSON.stringify(record));
  // In production this would create a Stripe Checkout session and return its URL.
  res.json({ ok: true, next: "/checkout", plan: record.plan });
});

// Simulated checkout / pre-order confirmation page.
app.get("/checkout", (req, res) => {
  const plan = req.query.plan || "beta_monthly";
  res.render("checkout", { plan });
});

// Lightweight admin view of captured intents (JSON).
app.get("/api/intents", (_req, res) => {
  try {
    const lines = fs.readFileSync(INTENT_LOG, "utf8").trim().split("\n").filter(Boolean);
    res.json({ count: lines.length, intents: lines.map((l) => JSON.parse(l)) });
  } catch {
    res.json({ count: 0, intents: [] });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
