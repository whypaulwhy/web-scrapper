// Empty by default: the frontend and API share an origin (Vite proxy locally, Vercel rewrite in production).
// Set VITE_API_URL to point the UI at a backend hosted somewhere else.
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export async function summarizeUrl(url, signal) {
  let response;
  try {
    response = await fetch(`${API_BASE}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Could not reach the server. Make sure the backend is running and try again.');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `The server returned an unexpected error (HTTP ${response.status}).`);
  }
  if (!data) throw new Error('The server returned an invalid response.');
  return data;
}
