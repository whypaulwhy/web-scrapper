# AI Web Scraper & Summarizer

A full-stack web app: paste a webpage URL, click **Summarize**, and the backend scrapes the page's main text and sends it to a **free AI API** (Google Gemini by default, Groq also supported). The frontend shows the summary and key points.

**Live demo:** <https://web-scrapper-dun-tau.vercel.app>

![Stack](https://img.shields.io/badge/frontend-React%20%2B%20Vite-0f766e) ![Stack](https://img.shields.io/badge/backend-Node.js%20%2B%20Express-0f766e) ![Stack](https://img.shields.io/badge/AI-Gemini%20%7C%20Groq%20(free%20tier)-0f766e)

---

## Features

- **Frontend (React + Vite):** a URL input and a **Summarize** button, a **"Loading..."** state while the backend works, and a summary card with the page title, source link, word count, reading time, the AI summary, key points and a copy button. Errors get their own message and a retry button. Works on phones and supports dark mode.
- **Backend (Node.js + Express):** a `POST /api/summarize` endpoint that takes the URL from the frontend.
- **Scraping (fetch + Cheerio):** downloads the HTML, removes scripts, styles, navigation, headers, footers and sidebars, then pulls the text out of the main `<article>`/`<main>` area (or falls back to `<body>`).
- **AI integration:** sends the scraped text to **Google Gemini** (`gemini-3.5-flash-lite`) or **Groq** (`llama-3.3-70b-versatile`). Both have free tiers and neither needs OpenAI. The model returns JSON (`summary` + `keyPoints`).
- **Safety & robustness:** checks the URL is valid, blocks requests to localhost and private networks (SSRF), stops after 15 s or 3 MB, follows at most 5 redirects, rejects pages that aren't HTML, rate-limits requests per IP, and returns readable error messages.
- **Tests:** unit tests for URL validation, SSRF checks, HTML extraction and AI reply parsing (`npm test`).

## Tech stack

| Layer      | Technology                                                    |
| ---------- | ------------------------------------------------------------- |
| Frontend   | React 19, Vite 8, plain CSS                                   |
| Backend    | Node.js (>= 20.19), Express 5, Cheerio, express-rate-limit    |
| AI         | Google Gemini API (free tier) or Groq API (free tier)          |
| Deployment | Vercel Services (Vite frontend + Express backend, one domain) |

## Project structure

```
web-scrapper/
├── backend/                 # Express API
│   ├── src/
│   │   ├── app.js           # Express app & routes (/api/summarize, /api/health)
│   │   ├── server.js        # Local dev server (loads backend/.env, listens on :3001)
│   │   ├── scraper.js       # URL validation, SSRF protection, fetching & text extraction
│   │   └── summarizer.js    # Gemini / Groq API calls and response parsing
│   ├── test/                # Unit tests (node:test)
│   ├── .env.example         # Template for your .env file  <-- copy this to backend/.env
│   └── package.json
├── frontend/                # React UI (Vite)
│   ├── src/
│   │   ├── App.jsx          # Input, Summarize button, loading / error / result states
│   │   ├── api.js           # Calls the backend API
│   │   ├── main.jsx
│   │   └── styles.css
│   ├── index.html
│   ├── vite.config.js       # Proxies /api to the backend during development
│   └── package.json
├── vercel.json              # Vercel deployment: frontend + backend services, /api routing
└── package.json             # npm workspaces + scripts to run both apps
```

---

## Run it locally

### 1. Prerequisites

- **Node.js 20.19 or newer** (check with `node -v`) and npm
- A **free AI API key**. You only need one:
  - **Google Gemini (default):** sign in at <https://aistudio.google.com/apikey> and click **Create API key**.
  - **Groq (alternative):** sign up at <https://console.groq.com/keys> and create a key.

### 2. Clone and install

```bash
git clone https://github.com/whypaulwhy/web-scrapper.git
cd web-scrapper
npm install
```

`npm install` at the repo root installs the dependencies for **both** `backend/` and `frontend/` (they're npm workspaces).

### 3. Create the `.env` file (AI API key)

The `.env` file goes in the **`backend/` folder**: **`backend/.env`**. Only the backend reads it. The frontend never sees your key.

Copy the template:

```bash
# macOS / Linux / Git Bash
cp backend/.env.example backend/.env

# Windows PowerShell
Copy-Item backend/.env.example backend/.env
```

Then open `backend/.env` and paste your key:

```env
# Using Google Gemini (default)
GEMINI_API_KEY=your_gemini_api_key_here

# ...or using Groq instead
# GROQ_API_KEY=your_groq_api_key_here
```

All supported variables:

| Variable         | Required | Default                   | Description                                                        |
| ---------------- | -------- | ------------------------- | ------------------------------------------------------------------ |
| `GEMINI_API_KEY` | one of   | –                         | Google Gemini API key                                              |
| `GROQ_API_KEY`   | one of   | –                         | Groq API key                                                       |
| `AI_PROVIDER`    | no       | auto                      | `gemini` or `groq`. If unset, uses whichever key is present (Gemini first). |
| `GEMINI_MODEL`   | no       | `gemini-3.5-flash-lite`   | Gemini model to use                                                |
| `GROQ_MODEL`     | no       | `llama-3.3-70b-versatile` | Groq model to use                                                  |
| `PORT`           | no       | `3001`                    | Port for the local backend                                         |
| `CORS_ORIGIN`    | no       | `*`                       | Allowed origin if the frontend is hosted on another domain         |

> `backend/.env` is listed in `.gitignore`, so it never gets committed. Don't put API keys in the frontend.

### 4. Start the backend and frontend

**Option A: both together with one command (from the repo root):**

```bash
npm run dev
```

**Option B: in two separate terminals:**

```bash
# Terminal 1: backend API at http://localhost:3001
cd backend
npm run dev
```

```bash
# Terminal 2: frontend at http://localhost:5173
cd frontend
npm run dev
```

Then open **<http://localhost:5173>**, paste a URL (for example `https://en.wikipedia.org/wiki/Web_scraping`) and click **Summarize**.

During development the Vite dev server forwards every `/api/*` request to the backend at `http://localhost:3001` (see `frontend/vite.config.js`). If your backend runs somewhere else, start the frontend with `BACKEND_URL=http://host:port`.

### 5. Run the tests

```bash
npm test
```

### Production build (optional)

```bash
npm run build      # builds the frontend into frontend/dist
npm start          # starts the backend API only (port 3001)
```

---

## API reference

### `POST /api/summarize`

Request:

```json
{ "url": "https://en.wikipedia.org/wiki/Web_scraping" }
```

Successful response (`200`):

```json
{
  "url": "https://en.wikipedia.org/wiki/Web_scraping",
  "title": "Web scraping - Wikipedia",
  "description": "",
  "summary": "Web scraping is the automated extraction of data from websites...",
  "keyPoints": ["...", "..."],
  "wordCount": 4273,
  "readingTimeMinutes": 19,
  "truncated": true,
  "provider": "Google Gemini",
  "model": "gemini-3.5-flash-lite"
}
```

Error response (`4xx` / `5xx`):

```json
{ "error": "Could not find a website at \"example.invalid\". Check the address and try again." }
```

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 400    | Missing/invalid URL, or a URL pointing to a private/local network        |
| 415    | The URL isn't an HTML page (for example an image or PDF)                 |
| 422    | Domain not found, or no readable text on the page                        |
| 429    | Too many requests (15/min per IP), or the free AI quota was reached      |
| 500    | The server's AI API key is missing or invalid                            |
| 502/504| The website or the AI service failed or timed out                        |

### `GET /api/health`

Returns `{ "status": "ok", "provider": "...", "model": "...", "aiConfigured": true }`. You can use it to check whether the API key was picked up.

Quick test with curl:

```bash
curl -X POST http://localhost:3001/api/summarize -H "Content-Type: application/json" -d "{\"url\":\"https://example.com\"}"
```

---

## How it works

1. The user pastes a URL and clicks **Summarize**. The React app sends `POST /api/summarize` and shows **Loading...**.
2. The backend checks the URL (http/https only, the host must resolve to a public IP) and downloads the HTML. It follows redirects itself so it can check every hop.
3. Cheerio removes `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, forms and hidden elements. It then picks the main content container and turns block elements into clean lines of text. Pages longer than 15,000 characters get cut to that length.
4. The text goes to the AI with a prompt asking for a 2–4 sentence summary and 3–5 key points as JSON. The prompt tells the model to treat the page text as data and ignore any instructions in it.
5. The backend sends back the summary plus some page details, and the frontend shows them in a card.

## Deployment (Vercel)

The live app runs on Vercel at **<https://web-scrapper-dun-tau.vercel.app>**. Every push to `main` deploys it again automatically.

`vercel.json` uses [Vercel Services](https://vercel.com/docs/services) to run both parts of the repo as one project on one domain:

- **`frontend`** service: `frontend/` is built with Vite and served as static files.
- **`backend`** service: `backend/` runs the Express app (`backend/src/app.js`) as a Vercel Function.
- Requests to `/api/*` go to the backend and everything else goes to the frontend. The frontend calls the API on the same domain, so CORS doesn't apply.

To deploy your own copy:

1. Import the GitHub repo in Vercel (or run `vercel deploy --prod` from the repo root).
2. In **Project → Settings → Environment Variables**, add `GEMINI_API_KEY` (or `GROQ_API_KEY`) for the Production environment.
3. Redeploy, then open `https://<your-app>.vercel.app/api/health`. It should show `"aiConfigured": true`.

## Limitations

- Only **static HTML** gets scraped. Pages that render their content with JavaScript (many single-page apps), pages behind a login and sites with strong bot protection may return little text or an error. The task brief asked to keep scraping simple, so this is intentional.
- Long pages get truncated to their first ~15,000 characters before summarizing.
- Free AI tiers have rate limits. If you see a quota message, wait a minute and try again.

## License

MIT
