// Real pre-order: captures email, calls /api/pre-order, redirects to Stripe TEST checkout.
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
