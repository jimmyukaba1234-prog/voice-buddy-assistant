# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal AI voice assistant ("Heney") — a React + Vite frontend talks to a small Express backend that proxies to Google Gemini. The browser handles speech-to-text capture, while speaking is ElevenLabs-only through the backend TTS endpoint. There is no database, auth, or persistence — chat history lives in React state and is sent with each request.

## Two packages, two terminals

The repo holds **two independent npm packages** with separate `package.json`/`node_modules`:

- **Frontend** at the project root (`src/`, `index.html`, `vite.config.js`) — React 18 + Vite.
- **Backend** in `backend/` — Express + `@google/genai`.

You must `npm install` in each, and run them in separate terminals during development.

### Commands

```bash
# Backend (terminal 1) — runs on http://localhost:3001
cd backend
npm install
cp .env.example .env        # then add GEMINI_API_KEY
npm run dev                 # node --watch, auto-restart  (npm start = no watch)

# Frontend (terminal 2) — runs on http://localhost:5173
npm install
npm run dev                 # vite dev server
npm run build               # production build to dist/
npm run preview             # serve the built dist/
```

There is **no test runner and no linter configured** — do not assume `npm test`/`npm run lint` exist in either package.

### Required config

`backend/.env` (copy from `backend/.env.example`) must define `GEMINI_API_KEY`. Optional: `GEMINI_MODEL` (default `gemini-2.5-flash`), `PORT` (default `3001`). Without the key the backend still boots but `/api/chat` returns HTTP 500.

## Architecture

- **Frontend → backend is same-origin.** `src/lib/api.js` fetches `/api/chat` with no host, relying on the Vite dev proxy (`vite.config.js`) to forward `/api/*` to `localhost:3001`. If you change the backend port, update both the proxy target and `backend/.env`. The API contract is `POST /api/chat { message, history } → { reply }`; there is also `GET /api/health`.

- **History format translation happens in `backend/server.js`.** The frontend stores messages as `{ role: "user" | "assistant", text }`. The backend maps these to Gemini's `contents` shape — `assistant` → `model`, `text` → `parts: [{ text }]` — and appends the new message. The assistant persona is set via `systemInstruction` in the `generateContent` call, not in the frontend.

- **`src/App.jsx` is the entire UI and contains all the voice-control complexity.** The non-obvious part is the **ref-mirror pattern**: nearly every piece of state (`messages`, `assistantMode`, `loading`, `listening`, `speaking`, etc.) has a paired `...Ref`, kept in sync via `useEffect`. This exists because long-lived speech recognition and audio playback callbacks would otherwise close over stale state. **When adding state that any speech callback reads, add and maintain its ref too**, or the callback will see stale values.

- **"Assistant Mode" is a hands-free state machine.** When on, the app continuously cycles listen → transcribe → send → speak → listen. The loop is driven by `scheduleListening()` (a debounced `setTimeout` in `restartTimerRef`) and gated on `!loading && !speaking` to avoid the mic capturing the assistant's own TTS output. `recognition` is configured non-continuous (`continuous = false`), so each turn is a fresh `start()`; the `onend` handler re-arms the cycle. The manual 🎤 button (`toggleListening`) is a separate, single-shot path and is disabled while Assistant Mode is on.

- **Browser support matters.** Web Speech API works best in Chrome/Edge; mic requires `localhost` or HTTPS. Do not add client-side TTS fallback paths; Heney speech output must remain ElevenLabs-only.
