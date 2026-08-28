// Captures payment intent: tracks the CTA click, then routes to checkout.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".js-checkout");
  if (!btn) return;
  e.preventDefault();
  const plan = btn.dataset.plan || "beta_monthly";
  let visitor = null;
  try { visitor = localStorage.getItem("_pv"); } catch (_) {}

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Redirection…";

  try {
    const res = await fetch("/api/checkout-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, visitor }),
    });
    const data = await res.json();
    window.location.href = (data.next || "/checkout") + "?plan=" + encodeURIComponent(plan);
  } catch (_) {
    // Fallback: still route to checkout so intent isn't lost.
    window.location.href = "/checkout?plan=" + encodeURIComponent(plan);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
