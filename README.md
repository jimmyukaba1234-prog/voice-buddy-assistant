# Heney Assistant

A personal AI voice assistant. Sign in, then type or speak to it — it reasons with
**Google Gemini**, speaks replies with **ElevenLabs** TTS, and remembers conversations,
reminders, and long-term facts about you in **Supabase**. A small local "skills" layer
answers things like math, weather, news, and reminders directly without calling Gemini.

For the full, verified architecture (request flows, API reference, database schema,
skills system, known risks) see **[PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)**. For what's
being built next and why, see **[HENEY_ROADMAP.md](./HENEY_ROADMAP.md)** (and
`HENEY_DECISIONS.md`, once it exists).

## Project layout

Two independent npm packages — install and run each separately:

- **Frontend** at the repo root (`src/`, `index.html`, `vite.config.js`) — React + Vite.
- **Backend** in `backend/` (`server.js`) — Express, proxies Gemini/ElevenLabs, and
  verifies the caller's Supabase session on every route.

Data (conversations, messages, memories, reminders) lives in Supabase and is read/written
directly from the frontend using RLS; the backend does not hold its own database
connection for user data — only a service-role client used for auth verification and
audit logging (see PROJECT_CONTEXT.md §3–§4).

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Fill in `backend/.env` — see the comments in `backend/.env.example` for what each
variable is and where to get it (Gemini, ElevenLabs, and your Supabase project's URL +
service role key). Then start it:

```bash
npm run dev      # auto-restart on changes
# or
npm start
```

The API runs at **http://localhost:3001**.

### 2. Frontend

In a **second terminal**, from the project root:

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev
```

Fill in `.env` — see `.env.example` for what each variable is (your Supabase project URL
+ anon key, and optionally `VITE_API_BASE_URL` if the backend isn't on localhost:3001).

The app runs at **http://localhost:5173**. Vite proxies `/api/*` requests to the
backend, so no extra configuration is needed in dev.

## Usage

1. Open http://localhost:5173 in **Chrome or Edge** (best Web Speech API support).
2. Sign in or create an account (Supabase email/password auth).
3. Type a message and press **Send** (or **Enter**), or turn on **Assistant Mode** for
   hands-free voice.

## Notes

- Microphone input and speech synthesis are **browser features** — Chrome and Edge
  work best. Some browsers (e.g. Firefox) have limited Web Speech API support.
- The microphone requires `localhost` or HTTPS to work.
- Every backend route requires a valid Supabase session token; the backend enforces its
  own CORS allowlist and per-user rate limits (see PROJECT_CONTEXT.md).
