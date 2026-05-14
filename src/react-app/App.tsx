import { useState } from "react";
import "./App.css";

function App() {
  const [pdfUrl, setPdfUrl] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleConvert(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setImageUrl(null);
    setLoading(true);
    try {
      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pdfUrl }),
      });
      const data = (await res.json()) as { imageUrl?: string; error?: string };
      if (!res.ok || !data.imageUrl) {
        setError(data.error ?? `Request failed (${res.status})`);
      } else {
        setImageUrl(data.imageUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <h1>pdf2img</h1>
      <p>
        Free API: POST a PDF URL, get back a single PNG. Multi-page PDFs are
        stitched vertically at their original page width.
      </p>

      <pre className="snippet">{`POST /api/convert
Content-Type: application/json

{ "url": "https://example.com/file.pdf" }

→ { "imageUrl": "https://.../api/image/<id>.png" }`}</pre>

      <form onSubmit={handleConvert} className="form">
        <input
          type="url"
          required
          placeholder="https://example.com/file.pdf"
          value={pdfUrl}
          onChange={(e) => setPdfUrl(e.target.value)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Converting..." : "Convert"}
        </button>
      </form>

      {error && <p className="error">Error: {error}</p>}
      {imageUrl && (
        <div className="result">
          <p>
            <a href={imageUrl} target="_blank" rel="noopener noreferrer">
              {imageUrl}
            </a>
          </p>
          <img src={imageUrl} alt="Converted PDF" />
        </div>
      )}

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
