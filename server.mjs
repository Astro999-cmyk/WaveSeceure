import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const dataDir = join(root, "data");
const dbFile = join(dataDir, "wavesecure-db.json");
const port = Number(process.env.PORT || 4173);

const plans = {
  Maand: { price: 12.5, expiresInDays: 30, label: "Maand licentie" },
  Kwartaal: { price: 25, expiresInDays: 90, label: "Kwartaal licentie" },
  Lifetime: { price: 45, expiresInDays: null, label: "Lifetime licentie" },
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const defaultDb = {
  users: [],
  sessions: {},
  coupons: [{ code: "WAVE10", amount: 10, createdAt: new Date().toISOString() }],
  licenses: [],
  bans: [],
  actions: [],
  mails: [],
};

const ensureDb = () => {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dbFile)) writeFileSync(dbFile, JSON.stringify(defaultDb, null, 2));
};

const readDb = () => {
  ensureDb();
  return JSON.parse(readFileSync(dbFile, "utf8"));
};

const writeDb = (db) => writeFileSync(dbFile, JSON.stringify(db, null, 2));

const send = (res, status, body, headers = {}) => {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(data);
};

const bodyJson = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });

const cookie = (req, key) => {
  const header = req.headers.cookie || "";
  return header
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === key)?.[1];
};

const hashPassword = (password, salt = randomBytes(16).toString("hex")) => {
  const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (password, stored) => {
  const [salt, hash] = stored.split(":");
  const candidate = hashPassword(password, salt).split(":")[1];
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
};

const publicUser = (user) => user && { id: user.id, name: user.name, email: user.email, provider: user.provider };

const currentUser = (req, db) => {
  const sessionId = cookie(req, "ws_session");
  const userId = sessionId && db.sessions[sessionId];
  return db.users.find((user) => user.id === userId);
};

const requireUser = (req, res, db) => {
  const user = currentUser(req, db);
  if (!user) send(res, 401, { error: "Log eerst in." });
  return user;
};

const createSession = (res, db, userId) => {
  const sessionId = randomBytes(24).toString("hex");
  db.sessions[sessionId] = userId;
  res.setHeader("Set-Cookie", `ws_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
};

const licenseKey = () => `WAVE-${randomBytes(3).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;

const routeApi = async (req, res, url) => {
  const db = readDb();

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = currentUser(req, db);
    const licenses = user ? db.licenses.filter((license) => license.userId === user.id) : [];
    send(res, 200, { user: publicUser(user), licenses });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await bodyJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || email.split("@")[0] || "Wave klant").trim();
    if (!email || password.length < 6) return send(res, 400, { error: "Gebruik een geldig e-mailadres en minimaal 6 tekens wachtwoord." });
    if (db.users.some((user) => user.email === email)) return send(res, 409, { error: "Dit account bestaat al. Log in." });
    const user = { id: randomBytes(12).toString("hex"), name, email, provider: "email", passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user);
    createSession(res, db, user.id);
    writeDb(db);
    send(res, 201, { user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await bodyJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) return send(res, 401, { error: "E-mail of wachtwoord klopt niet." });
    createSession(res, db, user.id);
    writeDb(db);
    send(res, 200, { user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/oauth-dev") {
    const body = await bodyJson(req);
    const provider = body.provider === "Discord" ? "Discord" : "Google";
    const email = `${provider.toLowerCase()}@wavesecure.local`;
    let user = db.users.find((item) => item.email === email);
    if (!user) {
      user = {
        id: randomBytes(12).toString("hex"),
        name: `${provider} gebruiker`,
        email,
        provider,
        passwordHash: hashPassword(randomBytes(18).toString("hex")),
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
    }
    createSession(res, db, user.id);
    writeDb(db);
    send(res, 200, { user: publicUser(user), note: "Vervang deze dev-login later door echte OAuth credentials." });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const sessionId = cookie(req, "ws_session");
    if (sessionId) delete db.sessions[sessionId];
    writeDb(db);
    send(res, 200, { ok: true }, { "Set-Cookie": "ws_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/coupons") {
    send(res, 200, { coupons: db.coupons });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/coupons") {
    const user = requireUser(req, res, db);
    if (!user) return true;
    const body = await bodyJson(req);
    const code = String(body.code || "").trim().toUpperCase();
    const amount = Number(body.amount);
    if (!code || !Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: "Gebruik /korting CODE bedrag." });
    const existing = db.coupons.find((coupon) => coupon.code === code);
    if (existing) existing.amount = amount;
    else db.coupons.push({ code, amount, createdAt: new Date().toISOString() });
    writeDb(db);
    send(res, 200, { coupon: { code, amount } });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/apply-coupon") {
    const body = await bodyJson(req);
    const code = String(body.code || "").trim().toUpperCase();
    const plan = plans[body.plan];
    const coupon = db.coupons.find((item) => item.code === code);
    if (!plan) return send(res, 400, { error: "Kies eerst een licentie." });
    if (!coupon) return send(res, 404, { error: "Kortingscode bestaat niet." });
    send(res, 200, { code, discount: Math.min(plan.price, coupon.amount) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/purchase") {
    const user = requireUser(req, res, db);
    if (!user) return true;
    const body = await bodyJson(req);
    const planName = body.plan;
    const plan = plans[planName];
    if (!plan) return send(res, 400, { error: "Kies een geldig pakket." });
    const coupon = db.coupons.find((item) => item.code === String(body.coupon || "").trim().toUpperCase());
    const discount = coupon ? Math.min(plan.price, coupon.amount) : 0;
    const now = new Date();
    const expiresAt = plan.expiresInDays ? new Date(now.getTime() + plan.expiresInDays * 86400000).toISOString() : null;
    const license = {
      id: randomBytes(12).toString("hex"),
      userId: user.id,
      plan: planName,
      key: licenseKey(),
      subtotal: plan.price,
      discount,
      total: Math.max(0, plan.price - discount),
      status: "active",
      serverName: "Rijnstad Roleplay V1",
      version: "2.11.20",
      playerLimit: 5,
      expiresAt,
      createdAt: now.toISOString(),
    };
    db.licenses.push(license);
    db.mails.push({
      to: user.email,
      subject: "Je WaveSecure download staat klaar",
      body: `Download: http://localhost:${port}/download/latest\nLicentie: ${license.key}\nDeel je bestanden of key niet. Delen leidt tot een permanente blacklist.`,
      createdAt: now.toISOString(),
    });
    writeDb(db);
    send(res, 201, { license });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const user = requireUser(req, res, db);
    if (!user) return true;
    send(res, 200, {
      user: publicUser(user),
      licenses: db.licenses.filter((license) => license.userId === user.id),
      bans: db.bans.filter((ban) => ban.userId === user.id),
      actions: db.actions.filter((action) => action.userId === user.id).slice(-20).reverse(),
      mails: db.mails.filter((mail) => mail.to === user.email).slice(-5).reverse(),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bans") {
    const user = requireUser(req, res, db);
    if (!user) return true;
    const body = await bodyJson(req);
    const player = String(body.player || "").trim();
    const reason = String(body.reason || "").trim();
    if (!player || !reason) return send(res, 400, { error: "Vul speler en reden in." });
    const ban = { id: randomBytes(10).toString("hex"), userId: user.id, player, reason, createdAt: new Date().toISOString() };
    db.bans.unshift(ban);
    writeDb(db);
    send(res, 201, { ban });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/actions") {
    const user = requireUser(req, res, db);
    if (!user) return true;
    const body = await bodyJson(req);
    const type = String(body.type || "Actie").trim();
    const action = { id: randomBytes(10).toString("hex"), userId: user.id, type, createdAt: new Date().toISOString() };
    db.actions.push(action);
    writeDb(db);
    send(res, 201, { action });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/download/latest") {
    const user = requireUser(req, res, db);
    if (!user) return true;
    const license = db.licenses.find((item) => item.userId === user.id && item.status === "active");
    if (!license) return send(res, 403, { error: "Koop eerst een licentie." });
    const resource = [
      "WaveSecure Anticheat FiveM Resource",
      `License key: ${license.key}`,
      "Installatie: plaats deze map in je FiveM resources en voeg ensure wavesecure toe aan server.cfg.",
      "Niet delen. Delen leidt tot een permanente blacklist.",
    ].join("\n");
    send(res, 200, resource, {
      "Content-Disposition": "attachment; filename=wavesecure-resource.txt",
      "Content-Type": "text/plain; charset=utf-8",
    });
    return true;
  }

  return false;
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/download/")) {
      const handled = await routeApi(req, res, url);
      if (!handled) send(res, 404, { error: "Route niet gevonden." });
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = normalize(join(root, requested));
    if (!file.startsWith(root) || !existsSync(file)) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(res);
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}).listen(port, () => {
  console.log(`WaveSecure running on http://localhost:${port}`);
});
