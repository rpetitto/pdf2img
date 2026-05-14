import { app, storage, db, migrate } from "flingit";
import { email } from "flingit/plugin/email-send";

// mupdf is loaded lazily — the Fling deploy pipeline runs a metadata
// extraction pass that stubs `.wasm` imports to empty buffers, and mupdf's
// top-level await would crash trying to instantiate an empty WASM module.
// Lazy loading keeps that pass clean; the cost on the first real request
// is the one-time WASM init.
type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;
async function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) {
    mupdfPromise = (async () => {
      await import("./mupdf-init");
      return await import("mupdf");
    })();
  }
  return mupdfPromise;
}

// ============================================================
// Migrations
// ============================================================

migrate("001_users", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`).run();
});

migrate("002_magic_links", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )
  `).run();
});

migrate("003_sessions", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `).run();
});

// ============================================================
// Constants & helpers
// ============================================================

const SESSION_COOKIE = "pdf2img_session";
const SESSION_TTL_SECONDS = 30 * 86400;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])?$/;
const RESERVED_USERNAMES = new Set([
  "api", "www", "admin", "root", "auth", "login", "logout", "signup",
  "signin", "verify", "me", "user", "users", "static", "assets", "public",
]);
const PNG_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "public, max-age=31536000, immutable",
};

type HonoContext = Parameters<Parameters<typeof app.get>[1]>[0];

interface User {
  id: number;
  email: string;
  username: string | null;
}

function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function makeSessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function isSecureRequest(c: HonoContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function originOf(c: HonoContext): string {
  return new URL(c.req.url).origin;
}

async function currentUser(c: HonoContext): Promise<User | null> {
  const cookies = parseCookies(c.req.header("cookie"));
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const row = await db
    .prepare(
      `SELECT u.id AS id, u.email AS email, u.username AS username, s.expires_at AS expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .bind(sid)
    .first<{ id: number; email: string; username: string | null; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, username: row.username };
}

// ============================================================
// Auth routes
// ============================================================

app.post("/api/auth/request-link", async (c) => {
  let body: { email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const emailAddr = (body.email ?? "").trim().toLowerCase();
  if (!emailAddr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr)) {
    return c.json({ error: "Invalid email address" }, 400);
  }

  const token = randomToken(32);
  const expiresAt = Date.now() + MAGIC_LINK_TTL_MS;
  await db
    .prepare(`INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)`)
    .bind(token, emailAddr, expiresAt)
    .run();

  const link = `${originOf(c)}/api/auth/verify?token=${token}`;
  await email.send({
    to: emailAddr,
    subject: "Sign in to pdf2img",
    text:
      `Click the link below to sign in to pdf2img:\n\n${link}\n\n` +
      `This link expires in 15 minutes. If you didn't request it, ignore this email.`,
    html:
      `<p>Click the button below to sign in to pdf2img:</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#0066cc;color:#fff;text-decoration:none;border-radius:6px;">Sign in to pdf2img</a></p>` +
      `<p>Or paste this link into your browser:<br><a href="${link}">${link}</a></p>` +
      `<p style="color:#666;font-size:13px;">This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`,
  });

  return c.json({ ok: true });
});

app.get("/api/auth/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.text("Missing token", 400);
  const row = await db
    .prepare(`SELECT email, expires_at, used_at FROM magic_links WHERE token = ?`)
    .bind(token)
    .first<{ email: string; expires_at: number; used_at: number | null }>();
  if (!row) return c.text("Invalid sign-in link.", 400);
  if (row.used_at) return c.text("This sign-in link has already been used.", 400);
  if (row.expires_at < Date.now()) return c.text("This sign-in link has expired.", 400);

  await db.prepare(`UPDATE magic_links SET used_at = ? WHERE token = ?`).bind(Date.now(), token).run();

  const existing = await db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .bind(row.email)
    .first<{ id: number }>();
  let userId: number;
  if (existing) {
    userId = existing.id;
  } else {
    const ins = await db
      .prepare(`INSERT INTO users (email) VALUES (?) RETURNING id`)
      .bind(row.email)
      .first<{ id: number }>();
    if (!ins) return c.text("Failed to create account", 500);
    userId = ins.id;
  }

  const sid = randomToken(32);
  const sessionExpiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await db
    .prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(sid, userId, sessionExpiresAt)
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": makeSessionCookie(sid, SESSION_TTL_SECONDS, isSecureRequest(c)),
    },
  });
});

app.post("/api/auth/logout", async (c) => {
  const cookies = parseCookies(c.req.header("cookie"));
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureRequest(c) ? "; Secure" : ""}`,
    },
  });
});

app.get("/api/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ user: null });
  return c.json({ user: { email: user.email, username: user.username } });
});

app.post("/api/username", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (user.username) return c.json({ error: "Username already set" }, 400);

  let body: { username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const username = (body.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return c.json(
      { error: "Username must be 3-30 chars: lowercase letters, digits, '_' or '-'; must start and end with a letter or digit." },
      400,
    );
  }
  if (RESERVED_USERNAMES.has(username)) {
    return c.json({ error: "That username is reserved." }, 400);
  }
  const taken = await db.prepare(`SELECT 1 FROM users WHERE username = ?`).bind(username).first();
  if (taken) return c.json({ error: "That username is already taken." }, 400);

  await db.prepare(`UPDATE users SET username = ? WHERE id = ?`).bind(username, user.id).run();
  return c.json({ ok: true, username });
});

// ============================================================
// PDF conversion (per-user URL: /<username>/<pdf_url>)
// ============================================================

function parsePdfUrl(raw: string): URL | null {
  let candidate = raw;
  try {
    candidate = decodeURIComponent(raw);
  } catch {
    // fall through
  }
  // Some image proxies (e.g. Cloudinary's f_auto fetch) append a "/" to the
  // URL they fetch. A PDF URL never legitimately ends in "/", so strip it.
  if (candidate.endsWith("/") && /\.[a-zA-Z0-9]{1,8}\/$/.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

async function fetchAndRender(pdfUrl: string): Promise<{ pdf: Uint8Array; png: Uint8Array }> {
  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`Failed to fetch PDF: HTTP ${resp.status}`);
  const pdf = new Uint8Array(await resp.arrayBuffer());
  const mupdf = await getMupdf();
  const png = renderPdfToStackedPng(mupdf, pdf);
  return { pdf, png };
}

async function getOrCreateCachedPng(username: string, pdfUrl: string): Promise<Uint8Array> {
  const hash = await sha256Hex(pdfUrl);
  const pngKey = `images/u/${username}/${hash}.png`;
  const pdfKey = `pdfs/u/${username}/${hash}.pdf`;

  const existing = await storage.get(pngKey);
  if (existing) return new Uint8Array(await existing.arrayBuffer());

  const { pdf, png } = await fetchAndRender(pdfUrl);
  await storage.put(pdfKey, pdf, { contentType: "application/pdf" });
  await storage.put(pngKey, png, { contentType: "image/png" });
  return png;
}

// GET /<username>/<pdf_url> — public, but only registered usernames work.
// Username pattern matches USERNAME_RE; "api" and the rest are filtered out
// either by the regex constraint or by RESERVED_USERNAMES on signup.
app.get("/:username{[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]}/:rest{.+}", async (c) => {
  const username = c.req.param("username");
  const user = await db
    .prepare(`SELECT 1 FROM users WHERE username = ?`)
    .bind(username)
    .first();
  if (!user) return c.text("Unknown user", 404);

  const url = new URL(c.req.url);
  const prefix = `/${username}/`;
  const after = url.pathname.slice(prefix.length) + url.search;
  const parsed = parsePdfUrl(after);
  if (!parsed) return c.text("Invalid PDF URL", 400);

  try {
    const png = await getOrCreateCachedPng(username, parsed.toString());
    return new Response(png, { headers: PNG_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Conversion failed";
    return c.text(message, 400);
  }
});

// ============================================================
// mupdf rendering
// ============================================================

function renderPdfToStackedPng(mupdf: Mupdf, pdfBytes: Uint8Array): Uint8Array {
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  try {
    const pageCount = doc.countPages();
    if (pageCount === 0) throw new Error("PDF has no pages");

    const pageDims: Array<{ width: number; height: number }> = [];
    let maxWidth = 0;
    let totalHeight = 0;
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const bounds = page.getBounds();
        const w = Math.ceil(bounds[2] - bounds[0]);
        const h = Math.ceil(bounds[3] - bounds[1]);
        pageDims.push({ width: w, height: h });
        if (w > maxWidth) maxWidth = w;
        totalHeight += h;
      } finally {
        page.destroy?.();
      }
    }
    if (maxWidth === 0 || totalHeight === 0) throw new Error("PDF pages have zero size");

    const colorspace = mupdf.ColorSpace.DeviceRGB;
    const combined = new mupdf.Pixmap(colorspace, [0, 0, maxWidth, totalHeight], false);
    try {
      combined.clear(255);
      let yOffset = 0;
      for (let i = 0; i < pageCount; i++) {
        const page = doc.loadPage(i);
        try {
          const bounds = page.getBounds();
          const translate = mupdf.Matrix.translate(-bounds[0], -bounds[1] + yOffset);
          const device = new mupdf.DrawDevice(translate, combined);
          try {
            page.run(device, mupdf.Matrix.identity);
          } finally {
            device.close();
            device.destroy?.();
          }
          yOffset += pageDims[i].height;
        } finally {
          page.destroy?.();
        }
      }
      return combined.asPNG();
    } finally {
      combined.destroy?.();
    }
  } finally {
    doc.destroy?.();
  }
}
