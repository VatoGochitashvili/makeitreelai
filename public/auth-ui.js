/* Shared nav auth state. Asks /api/me and, if logged in, replaces the
   Login/Sign-up buttons with a plan badge + avatar (linking to the account
   dashboard) and a Log out button. */
(async function () {
  const navRight = document.getElementById("navRight");
  if (!navRight) return;
  navRight.classList.add("resolving");
  const reveal = () => navRight.classList.remove("resolving");
  // Never leave the nav invisible if the request hangs.
  const failsafe = setTimeout(reveal, 2500);
  try {
    const r = await fetch("/api/me");
    const d = await r.json();
    if (!d.user) { clearTimeout(failsafe); reveal(); return; } // genuinely signed out
    const u = d.user;
    const initial = (u.name || u.email || "?").trim().charAt(0).toUpperCase();
    const planLabel = { free: "Free", creator: "Creator", pro: "Pro" }[u.plan] || u.plan;
    navRight.innerHTML = `
      <a class="btn ghost" href="/my-reels.html">My Reels</a>
      <a class="acct" href="/account.html" title="Account & billing">
        <span class="plan-tag">${planLabel}</span>
        <span class="avatar">${initial}</span>
      </a>
      <button class="btn ghost" id="logoutBtn">Log out</button>`;
    clearTimeout(failsafe);
    reveal();
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      location.href = "/";
    });
  } catch (_) { /* offline / not ready — show the signed-out nav */ }
  clearTimeout(failsafe);
  reveal();
})();
