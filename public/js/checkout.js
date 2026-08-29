// Captures email + UTM, calls /api/pre-order, redirects to Stripe TEST checkout.
// UTM params are read from the URL so attribution is preserved through the funnel.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".js-checkout");
  if (!btn) return;
  e.preventDefault();

  const plan = btn.dataset.plan || "beta_monthly";
  const emailTargetId = btn.dataset.emailTarget;
  const emailInput = emailTargetId ? document.getElementById(emailTargetId) : null;
  const email = emailInput ? emailInput.value.trim() : "";

  if (!email || !email.includes("@")) {
    if (emailInput) { emailInput.focus(); emailInput.style.borderColor = "#ef4444"; }
    return;
  }
  if (emailInput) emailInput.style.borderColor = "";

  // Read UTM params from current URL.
  const params = new URLSearchParams(location.search);
  const utmSource   = params.get("utm_source")   || undefined;
  const utmMedium   = params.get("utm_medium")   || undefined;
  const utmCampaign = params.get("utm_campaign") || undefined;
  const utmContent  = params.get("utm_content")  || undefined;
  let visitorId;
  try { visitorId = localStorage.getItem("_pv") || undefined; } catch(_) {}

  // Track the checkout intent.
  fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitor_id: visitorId, path: "/checkout-intent", utm_source: utmSource, utm_medium: utmMedium, utm_campaign: utmCampaign, referrer: document.referrer }),
  }).catch(() => {});

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Traitement…";

  try {
    const res = await fetch("/api/pre-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan, utm_source: utmSource, utm_medium: utmMedium, utm_campaign: utmCampaign, utm_content: utmContent }),
    });
    const data = await res.json();
    if (data.stripeUrl) {
      window.location.href = data.stripeUrl;
    } else {
      window.location.href = "/checkout?plan=" + encodeURIComponent(plan);
    }
  } catch (_) {
    window.location.href = "/checkout?plan=" + encodeURIComponent(plan);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// Track page views with UTM on load.
(function() {
  const params = new URLSearchParams(location.search);
  const payload = {
    visitor_id: null,
    path: location.pathname,
    utm_source: params.get("utm_source"),
    utm_medium: params.get("utm_medium"),
    utm_campaign: params.get("utm_campaign"),
    utm_content: params.get("utm_content"),
    referrer: document.referrer,
  };
  try { payload.visitor_id = localStorage.getItem("_pv"); } catch(_) {}
  fetch("/api/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
})();

  const btn = e.target.closest(".js-checkout");
  if (!btn) return;
  e.preventDefault();

  const plan = btn.dataset.plan || "beta_monthly";
  const emailTargetId = btn.dataset.emailTarget;
  const emailInput = emailTargetId ? document.getElementById(emailTargetId) : null;
  const email = emailInput ? emailInput.value.trim() : "";

  if (!email || !email.includes("@")) {
    if (emailInput) { emailInput.focus(); emailInput.style.borderColor = "#ef4444"; }
    return;
  }
  if (emailInput) emailInput.style.borderColor = "";

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Traitement…";

  try {
    const res = await fetch("/api/pre-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan }),
    });
    const data = await res.json();
    if (data.stripeUrl) {
      window.location.href = data.stripeUrl;
    } else {
      window.location.href = "/checkout?plan=" + encodeURIComponent(plan);
    }
  } catch (_) {
    window.location.href = "/checkout?plan=" + encodeURIComponent(plan);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
