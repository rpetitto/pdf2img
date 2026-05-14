import { app, storage } from "flingit";
import "./mupdf-init";
import * as mupdf from "mupdf";

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getOrigin(c: { req: { url: string; header: (k: string) => string | undefined } }): string {
  const forwardedHost = c.req.header("x-forwarded-host");
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

app.post("/api/convert", async (c) => {
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const pdfUrl = body.url;
  if (!pdfUrl || typeof pdfUrl !== "string") {
    return c.json({ error: "Missing 'url' field" }, 400);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pdfUrl);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return c.json({ error: "URL must be http or https" }, 400);
  }

  const pdfResp = await fetch(pdfUrl);
  if (!pdfResp.ok) {
    return c.json({ error: `Failed to fetch PDF: ${pdfResp.status}` }, 400);
  }
  const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer());

  let pngBytes: Uint8Array;
  try {
    pngBytes = renderPdfToStackedPng(pdfBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `PDF conversion failed: ${message}` }, 400);
  }

  const id = randomId();
  await storage.put(`pdfs/${id}.pdf`, pdfBytes, { contentType: "application/pdf" });
  await storage.put(`images/${id}.png`, pngBytes, { contentType: "image/png" });

  const imageUrl = `${getOrigin(c)}/api/image/${id}.png`;
  return c.json({ imageUrl });
});

app.get("/api/image/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[a-f0-9]+\.png$/.test(filename)) {
    return c.text("Not found", 404);
  }
  const file = await storage.get(`images/${filename}`);
  if (!file) return c.text("Not found", 404);
  const buffer = await file.arrayBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
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
