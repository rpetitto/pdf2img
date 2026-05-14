import { useState } from "react";
import "./App.css";

function App() {
  const [pdfUrl, setPdfUrl] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pdfUrl) return;
    const target = `${window.location.origin}/${pdfUrl}`;
    setImageUrl(target);
    setLoading(true);
  }

  return (
    <div className="app">
      <h1>pdf2img</h1>
      <p>
        Free Cloudinary-style PDF → image API. Append any PDF URL to this
        origin and you get back a single PNG. Multi-page PDFs are stitched
        vertically at their original page width.
      </p>

      <pre className="snippet">{`GET https://pdf2img.flingit.run/<pdf_url>

Example:
  https://pdf2img.flingit.run/https://example.com/file.pdf

→ image/png (cached after first render)`}</pre>

      <p style={{ marginTop: "1.5rem" }}>
        Try it: paste a PDF URL.
      </p>

      <form onSubmit={handleSubmit} className="form">
        <input
          type="url"
          required
          placeholder="https://example.com/file.pdf"
          value={pdfUrl}
          onChange={(e) => setPdfUrl(e.target.value)}
        />
        <button type="submit">Render</button>
      </form>

      {imageUrl && (
        <div className="result">
          <p>
            <a href={imageUrl} target="_blank" rel="noopener noreferrer">
              {imageUrl}
            </a>
          </p>
          {loading && <p>Loading…</p>}
          <img
            src={imageUrl}
            alt="Rendered PDF"
            onLoad={() => setLoading(false)}
            onError={() => setLoading(false)}
          />
        </div>
      )}

      <p className="footnote">
        Also available as JSON: <code>POST /api/convert</code> with{" "}
        <code>{`{ "url": "..." }`}</code> returns <code>{`{ "imageUrl": "..." }`}</code>.
      </p>

      <a
        href="https://flingit.io"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-4 left-4 flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-gray-200 rounded-full shadow-sm text-xs text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
      >
        <img src="/fling.svg" alt="Fling" className="w-4 h-4" />
        Made with Fling
      </a>
    </div>
  );
}

export default App;
