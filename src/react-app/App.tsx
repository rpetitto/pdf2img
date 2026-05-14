import { useEffect, useState } from "react";
import "./App.css";

interface Me {
  email: string;
  username: string | null;
}

type Stage = "loading" | "signed-out" | "needs-username" | "ready";

export default function App() {
  const [stage, setStage] = useState<Stage>("loading");
  const [me, setMe] = useState<Me | null>(null);

  async function refresh() {
    const res = await fetch("/api/me");
    const data = (await res.json()) as { user: Me | null };
    setMe(data.user);
    if (!data.user) setStage("signed-out");
    else if (!data.user.username) setStage("needs-username");
    else setStage("ready");
  }

  useEffect(() => {
    refresh();
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    await refresh();
  }

  return (
    <div className="app">
      <header className="hdr">
        <h1>pdf2img</h1>
        {me && (
          <div className="hdr-user">
            <span>{me.email}</span>
            <button onClick={logout} className="link-btn">Sign out</button>
          </div>
        )}
      </header>

      <p className="tag">
        Free Cloudinary-style PDF → image API. Multi-page PDFs are stitched
        vertically at their original page width.
      </p>

      {stage === "loading" && <p>Loading…</p>}
      {stage === "signed-out" && <SignIn />}
      {stage === "needs-username" && <PickUsername onDone={refresh} />}
      {stage === "ready" && me?.username && <Ready username={me.username} />}

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

function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);
    try {
      const res = await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        setState("error");
      } else {
        setState("sent");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div className="card">
        <h2>Check your inbox</h2>
        <p>
          We sent a sign-in link to <strong>{email}</strong>. Click the link
          to continue. You can close this tab — it’ll open a new one.
        </p>
        <button className="link-btn" onClick={() => setState("idle")}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Sign in</h2>
      <p>Enter your email to receive a one-time sign-in link.</p>
      <form onSubmit={submit} className="form">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={state === "sending"}
        />
        <button type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send link"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PickUsername({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to set username");
      } else {
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Pick a username</h2>
      <p>
        Your conversion URL will be{" "}
        <code>pdf2img.flingit.run/<strong>{username || "username"}</strong>/&lt;pdf_url&gt;</code>.
        Choose carefully — usernames can’t be changed.
      </p>
      <form onSubmit={submit} className="form">
        <input
          type="text"
          required
          minLength={3}
          maxLength={30}
          pattern="[a-z0-9][a-z0-9_\-]{1,28}[a-z0-9]"
          placeholder="your-handle"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          disabled={saving}
        />
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Claim"}
        </button>
      </form>
      <p className="hint">3–30 chars: lowercase letters, digits, <code>_</code> or <code>-</code>.</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Ready({ username }: { username: string }) {
  const origin = window.location.origin;
  const [pdfUrl, setPdfUrl] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pdfUrl) return;
    setImageUrl(`${origin}/${username}/${pdfUrl}`);
    setLoading(true);
  }

  return (
    <>
      <div className="card">
        <h2>Your endpoint</h2>
        <pre className="snippet">{`GET ${origin}/${username}/<pdf_url>

Example:
  ${origin}/${username}/https://example.com/file.pdf

→ image/png (cached after first render)`}</pre>
      </div>

      <div className="card">
        <h2>Try it</h2>
        <form onSubmit={submit} className="form">
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
      </div>
    </>
  );
}
