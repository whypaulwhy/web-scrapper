// Empty by default: the frontend and API share an origin (Vite proxy locally, Vercel routing in production).
// Set VITE_API_URL to point the UI at a backend hosted somewhere else.
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

// The backend gives up on slow websites and AI calls well before this; it's a last-resort guard.
const CLIENT_TIMEOUT_MS = 90_000;

export async function summarizeUrl(url, signal) {
  const timeout = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
  const combined = AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;

  let response;
  try {
    response = await fetch(`${API_BASE}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: combined,
    });
  } catch (err) {
    if (signal.aborted) throw err; // Cancelled by the user starting a new request.
    if (timeout.aborted) throw new Error('This is taking too long. The page may be very slow; try again in a moment.');
    throw new Error("Can't reach the server. Check your connection and try again.");
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `The server ran into a problem (HTTP ${response.status}). Try again in a moment.`);
  }
  if (!data || typeof data.summary !== 'string') {
    throw new Error('The server sent back something unexpected. Try again in a moment.');
  }
  return { ...data, keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [] };
}
