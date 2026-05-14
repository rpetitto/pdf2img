import { app, storage } from "flingit";
import "./mupdf-init";
import * as mupdf from "mupdf";

type HonoContext = Parameters<Parameters<typeof app.get>[1]>[0];

const PNG_CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "public, max-age=31536000, immutable",
};

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function parsePdfUrl(raw: string): URL | null {
  let candidate = raw;
  try {
    candidate = decodeURIComponent(raw);
  } catch {
    // fall through with raw
  }
  // Some image proxies (e.g. Cloudinary's f_auto fetch used by Glide) append
  // a trailing "/" to the fetched URL. A PDF URL never legitimately ends in
  // "/", so strip it before resolving.
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
  const pdfResp = await fetch(pdfUrl);
  if (!pdfResp.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${pdfResp.status}`);
  }
  const pdf = new Uint8Array(await pdfResp.arrayBuffer());
  const png = renderPdfToStackedPng(pdf);
  return { pdf, png };
}

async function getOrCreateCachedPng(pdfUrl: string): Promise<Uint8Array> {
  const hash = await sha256Hex(pdfUrl);
  const pngKey = `images/by-url/${hash}.png`;
  const pdfKey = `pdfs/by-url/${hash}.pdf`;

  const existing = await storage.get(pngKey);
  if (existing) {
    return new Uint8Array(await existing.arrayBuffer());
  }

  const { pdf, png } = await fetchAndRender(pdfUrl);
  await storage.put(pdfKey, pdf, { contentType: "application/pdf" });
  await storage.put(pngKey, png, { contentType: "image/png" });
  return png;
}

app.post("/api/convert", async (c: HonoContext) => {
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = body.url ? parsePdfUrl(body.url) : null;
  if (!parsed) {
    return c.json({ error: "Missing or invalid 'url' field (must be http/https)" }, 400);
  }

  const pdfBytes = await (async () => {
    const r = await fetch(parsed.toString());
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  })();
  if (!pdfBytes) {
    return c.json({ error: "Failed to fetch PDF" }, 400);
  }

  let pngBytes: Uint8Array;
  try {
    pngBytes = renderPdfToStackedPng(pdfBytes);
  } catch (err) {
    return c.json({ error: `PDF conversion failed: ${err instanceof Error ? err.message : "Unknown error"}` }, 400);
  }

  const id = randomId();
  await storage.put(`pdfs/${id}.pdf`, pdfBytes, { contentType: "application/pdf" });
  await storage.put(`images/${id}.png`, pngBytes, { contentType: "image/png" });

  const origin = new URL(c.req.url).origin;
  return c.json({ imageUrl: `${origin}/api/image/${id}.png` });
});

app.get("/api/image/:filename", async (c: HonoContext) => {
  const filename = c.req.param("filename");
  if (!/^[a-f0-9]+\.png$/.test(filename)) return c.text("Not found", 404);
  const file = await storage.get(`images/${filename}`);
  if (!file) return c.text("Not found", 404);
  const buffer = await file.arrayBuffer();
  return new Response(buffer, { headers: PNG_CACHE_HEADERS });
});

// Cloudinary-style URL: GET /<pdf_url>
// Example: https://pdf2img.flingit.run/https://example.com/file.pdf
// Returns the stitched PNG bytes directly.
app.get("/:rest{.+}", async (c: HonoContext) => {
  const url = new URL(c.req.url);
  // Reconstruct everything after the leading "/" including query string,
  // so URLs with their own query params survive (e.g. signed S3 URLs).
  const after = url.pathname.slice(1) + url.search;

  const parsed = parsePdfUrl(after);
  if (!parsed) {
    // Not a PDF URL request — fall through to the static asset handler.
    return c.notFound();
  }

  try {
    const png = await getOrCreateCachedPng(parsed.toString());
    return new Response(png, { headers: PNG_CACHE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Conversion failed";
    return c.text(message, 400);
  }
});

function renderPdfToStackedPng(pdfBytes: Uint8Array): Uint8Array {
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

    if (maxWidth === 0 || totalHeight === 0) {
      throw new Error("PDF pages have zero size");
    }

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
