const state = {
  user: null,
  licenses: [],
  selectedPlan: null,
  subtotal: 0,
  discount: 0,
  coupon: "",
  authMode: "login",
};

const api = async (path, options = {}) => {
  if (location.protocol === "file:") {
    throw new Error("Open deze site via http://localhost:4173 zodat login en dashboard werken.");
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || data || "Er ging iets mis.");
  return data;
};

const money = (value) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(value);

const dateLabel = (value) => (value ? new Date(value).toLocaleDateString("nl-NL") : "Levenslang");

const toast = (message) => {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 4200);
};

const requireLogin = () => {
  if (state.user) return true;
  openAuth("login");
  toast("Log eerst in of maak een account.");
  return false;
};

const updateTotals = () => {
  document.getElementById("subtotal").textContent = money(state.subtotal);
  document.getElementById("discount").textContent = money(state.discount);
  document.getElementById("total").textContent = money(Math.max(0, state.subtotal - state.discount));
};

const updateAccount = () => {
  document.getElementById("accountStatus").textContent = state.user ? state.user.email : "Niet ingelogd";
  document.getElementById("loginBtn").hidden = Boolean(state.user);
  document.getElementById("logoutBtn").hidden = !state.user;
};

const renderDashboard = async () => {
  updateAccount();

  const license = state.licenses[0];
  document.getElementById("licenseNotice").textContent = license
    ? `Actieve ${license.plan} licentie: ${license.key}`
    : "Log in en koop een licentie om downloads, facturen en moderatie te gebruiken.";
  document.getElementById("serverStatus").textContent = license ? "Gekoppeld" : "Niet gekoppeld";
  document.getElementById("versionValue").textContent = license?.version || "-";
  document.getElementById("expiresValue").textContent = license ? dateLabel(license.expiresAt) : "-";
  document.getElementById("playerLimitValue").textContent = license?.playerLimit || "-";
  document.getElementById("onlinePlayers").textContent = license ? `0/${license.playerLimit}` : "0/0";

  if (!state.user) {
    renderList("banList", []);
    renderList("actionList", []);
    renderList("mailList", []);
    document.getElementById("banCount").textContent = "0";
    return;
  }

  const data = await api("/api/dashboard");
  state.licenses = data.licenses;
  const bans = data.bans.map((ban) => `<strong>${escapeHtml(ban.player)}</strong><span>${escapeHtml(ban.reason)}</span>`);
  const actions = data.actions.map((action) => `${escapeHtml(action.type)} · ${new Date(action.createdAt).toLocaleTimeString("nl-NL")}`);
  const mails = data.mails.map((mail) => `${escapeHtml(mail.subject)} · naar ${escapeHtml(mail.to)}`);
  renderList("banList", bans);
  renderList("actionList", actions);
  renderList("mailList", mails);
  document.getElementById("banCount").textContent = data.bans.length;

  const newest = state.licenses[0];
  if (newest) {
    document.getElementById("licenseNotice").textContent = `Actieve ${newest.plan} licentie: ${newest.key}`;
    document.getElementById("serverStatus").textContent = "Gekoppeld";
    document.getElementById("versionValue").textContent = newest.version;
    document.getElementById("expiresValue").textContent = dateLabel(newest.expiresAt);
    document.getElementById("playerLimitValue").textContent = newest.playerLimit;
    document.getElementById("onlinePlayers").textContent = `0/${newest.playerLimit}`;
  }
};

const renderList = (id, rows) => {
  const list = document.getElementById(id);
  list.innerHTML = rows.length ? rows.map((row) => `<li>${row}</li>`).join("") : "<li>Nog geen data.</li>";
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);

const openAuth = (mode, provider = "") => {
  state.authMode = mode;
  document.getElementById("authTitle").textContent = mode === "register" ? "Account maken" : "Inloggen";
  document.getElementById("authText").textContent = provider
    ? `${provider} koppeling maakt nu een werkende lokale provider-sessie aan. Voor productie vul je echte OAuth credentials in.`
    : "Gebruik e-mail en wachtwoord om je licenties, downloads en servers te beheren.";
  document.getElementById("authName").parentElement.hidden = mode !== "register";
  document.getElementById("authSubmit").textContent = mode === "register" ? "Account maken" : "Inloggen";
  document.getElementById("authModal").showModal();
};

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(button.dataset.scroll).scrollIntoView({ behavior: "smooth" });
  });
});

document.querySelectorAll("[data-open-auth]").forEach((button) => {
  button.addEventListener("click", () => openAuth(button.dataset.openAuth, button.dataset.provider || ""));
});

document.querySelectorAll("[data-provider-login]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      const data = await api("/api/oauth-dev", {
        method: "POST",
        body: JSON.stringify({ provider: button.dataset.providerLogin }),
      });
      state.user = data.user;
      document.getElementById("authModal").close();
      toast(`${data.user.provider} account gekoppeld en ingelogd.`);
      await loadMe();
    } catch (error) {
      toast(error.message);
    }
  });
});

document.getElementById("authSubmit").addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      name: document.getElementById("authName").value,
      email: document.getElementById("authEmail").value,
      password: document.getElementById("authPassword").value,
    };
    const data = await api(state.authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.user = data.user;
    document.getElementById("authModal").close();
    toast(`Welkom ${state.user.name}.`);
    await loadMe();
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    state.user = null;
    state.licenses = [];
    toast("Je bent uitgelogd.");
    await renderDashboard();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelectorAll(".buy-btn").forEach((button) => {
  button.addEventListener("click", () => {
    state.selectedPlan = button.dataset.plan;
    state.subtotal = Number(button.dataset.price);
    state.discount = 0;
    state.coupon = "";
    document.getElementById("selectedPlan").textContent = `${state.selectedPlan} licentie`;
    document.getElementById("couponInput").value = "";
    updateTotals();
    document.getElementById("checkout").scrollIntoView({ behavior: "smooth" });
  });
});

document.getElementById("applyCoupon").addEventListener("click", async () => {
  try {
    if (!state.selectedPlan) throw new Error("Kies eerst een pakket.");
    const code = document.getElementById("couponInput").value.trim().toUpperCase();
    const data = await api("/api/apply-coupon", {
      method: "POST",
      body: JSON.stringify({ code, plan: state.selectedPlan }),
    });
    state.coupon = data.code;
    state.discount = data.discount;
    updateTotals();
    toast(`${data.code} toegepast: ${money(data.discount)} korting.`);
  } catch (error) {
    state.discount = 0;
    state.coupon = "";
    updateTotals();
    toast(error.message);
  }
});

document.getElementById("createCoupon").addEventListener("click", async () => {
  try {
    if (!requireLogin()) return;
    const code = document.getElementById("commandCode").value.trim().toUpperCase();
    const amount = Number(document.getElementById("commandAmount").value);
    const data = await api("/api/coupons", { method: "POST", body: JSON.stringify({ code, amount }) });
    document.getElementById("couponStatus").textContent = `Code ${data.coupon.code} staat klaar voor ${money(data.coupon.amount)} korting.`;
    toast(`Kortingscode actief: /korting ${data.coupon.code} ${data.coupon.amount}`);
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById("completePurchase").addEventListener("click", async () => {
  try {
    if (!state.selectedPlan) throw new Error("Selecteer eerst een licentie.");
    if (!requireLogin()) return;
    const data = await api("/api/purchase", {
      method: "POST",
      body: JSON.stringify({ plan: state.selectedPlan, coupon: state.coupon }),
    });
    toast(`${data.license.plan} licentie actief. Downloadmail staat in je outbox.`);
    await loadMe();
    document.getElementById("dashboard").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!requireLogin()) return;
  if (!state.licenses.length) {
    toast("Koop eerst een licentie voordat je kunt downloaden.");
    return;
  }
  window.location.href = "/download/latest";
});

document.getElementById("billingBtn").addEventListener("click", async () => {
  if (!requireLogin()) return;
  await renderDashboard();
  document.getElementById("mailList").scrollIntoView({ behavior: "smooth", block: "center" });
  toast("Facturering en downloadmail staan in de mail outbox.");
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      if (!requireLogin()) return;
      if (!state.licenses.length) throw new Error("Koop eerst een licentie om serveracties te gebruiken.");
      await api("/api/actions", { method: "POST", body: JSON.stringify({ type: button.dataset.action }) });
      toast(`${button.dataset.action} uitgevoerd.`);
      await renderDashboard();
    } catch (error) {
      toast(error.message);
    }
  });
});

document.getElementById("banForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (!requireLogin()) return;
    if (!state.licenses.length) throw new Error("Koop eerst een licentie om spelers te bannen.");
    const player = document.getElementById("playerName").value.trim();
    const reason = document.getElementById("banReason").value.trim();
    await api("/api/bans", { method: "POST", body: JSON.stringify({ player, reason }) });
    event.currentTarget.reset();
    toast(`${player} is geband en opgeslagen op de server.`);
    await renderDashboard();
  } catch (error) {
    toast(error.message);
  }
});

const loadMe = async () => {
  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.licenses = data.licenses || [];
  } catch {
    state.user = null;
    state.licenses = [];
  }
  await renderDashboard();
};

if (location.protocol === "file:") {
  toast("Open http://localhost:4173 voor de echte werkende versie met login en serverdata.");
} else {
  loadMe();
}

updateTotals();
updateAccount();
