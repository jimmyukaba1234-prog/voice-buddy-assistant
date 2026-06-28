# Heney Assistant

A simple personal AI voice assistant. Type or speak to it, it asks **Google Gemini**,
and reads the answer back to you using ElevenLabs through the backend TTS endpoint.

## Features

- 💬 Text chat with a ChatGPT-style interface
- 🎤 Voice input from the browser microphone (Web Speech API)
- 🔊 Spoken responses with ElevenLabs TTS only
- 🧠 Conversation history sent to Gemini for context
- ⚡ Loading indicator and clean, responsive UI

## Tech Stack

- **Frontend:** React + Vite (JavaScript, ES modules)
- **Backend:** Node.js + Express
- **LLM:** Google Gemini via `@google/genai`

## Project Structure

```
voice-buddy-assistant/
├── backend/
│   ├── .env.example      # copy to .env and add your key
│   ├── package.json
│   └── server.js         # Express API: /api/chat, /api/health
├── public/
│   └── vite.svg
├── src/
│   ├── lib/
│   │   └── api.js        # frontend → backend fetch helper
│   ├── App.jsx           # chat UI (mic, ElevenLabs TTS, history)
│   └── main.jsx
├── index.html
├── package.json          # frontend
├── vite.config.js        # dev server + /api proxy
└── README.md
```

> Note: the frontend lives at the project root; the backend lives in `backend/`.

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Open `backend/.env` and add your Gemini API key
(get one at https://aistudio.google.com/app/apikey):

```
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
PORT=3001
```

Start the backend:

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
npm run dev
```

The app runs at **http://localhost:5173**. Vite proxies `/api/*` requests to the
backend, so no extra configuration is needed.

## Usage

1. Open http://localhost:5173 in **Chrome or Edge** (best Web Speech API support).
2. Type a message and press **Send** (or **Enter**), **or** click the 🎤 button and speak.
3. Toggle **"Speak replies"** to turn spoken responses on/off.

## Notes

- Microphone input and speech synthesis are **browser features** — Chrome and Edge
  work best. Some browsers (e.g. Firefox) have limited Web Speech API support.
- The microphone requires `localhost` or HTTPS to work.
- This is an MVP: no database, authentication, or external tools — just chat.
