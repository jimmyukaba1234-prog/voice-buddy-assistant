# Heney Build Roadmap

Owner: Jimmy (Ukaba Jimmy Odigiri)
Status: Active build plan. Companion to HENEY_DECISIONS.md (the "why") and
PROJECT_CONTEXT.md (the "what exists"). This file is the "what to build, in what order."
Last updated: 19 July 2026

Working rules for every phase:
- One phase at a time. A phase is DONE only when every item in its "Definition of Done"
  passes, tested by you on the live deployment, not just locally.
- Each phase ends with: push, green CI, deploy verified, PROJECT_CONTEXT.md updated.
- Never start a feature phase while a security item from Phase 0 is unfinished.

---

## PHASE 0 — Harden & Prepare (blocking everything)

Goal: make the existing product safe to expose to real users and safe to build on.

Build:
1. Supabase JWT verification middleware on EVERY backend route; frontend sends the
   session token in an Authorization header on every request.
2. CORS restricted to the production Vercel domain and preview domains only.
3. Rate limiting on expensive endpoints: /api/chat, /api/chat/stream, /api/tts, /api/stt.
4. Wire up the tool_runs table: log every skill/tool invocation (user id, tool name,
   input summary, outcome, timestamp).
5. GitHub Actions CI: install, lint, and build for both packages on every push and PR.
6. Housekeeping: remove the stray image/ folder, delete the unused backend Supabase
   dependency or put it to use, refresh README.md.

Definition of Done:
- Calling any backend endpoint without a valid token returns 401 (test with curl).
- A request from an unknown origin is blocked by CORS.
- Hammering /api/tts rapidly gets rate-limited (429).
- Every chat interaction produces a tool_runs row you can see in Supabase.
- A deliberately broken push shows a red X in GitHub before you trust the deploy.

## PHASE 1 — Provider Switch + LangGraph Spine

Goal: OpenAI-first pipeline behind an abstraction, and the orchestrator that all
future features plug into.

Build:
1. Introduce the LangChain model interface on the backend; move reasoning from direct
   Gemini calls to OpenAI as primary with Gemini as config-switchable fallback.
2. Swap default TTS to OpenAI TTS (streaming) behind the existing /api/tts contract;
   keep ElevenLabs as a switchable premium voice. Migrate STT to OpenAI transcription.
3. Stand up LangGraph as the orchestrator for chat: user message in, tool router,
   response out. Migrate the 7 existing skills (calculator, weather, news, reminders,
   daily brief, conversation recall, memory) into LangGraph tools; retire the regex
   router.
4. Build the confirm-before-acting pattern ONCE at the orchestrator level: any tool
   marked irreversible must draft, read back, wait for explicit yes, execute, then log
   to tool_runs.
5. Do not refactor the voice pipeline (VAD, timing constants, streaming speaker) in
   this phase. It stays as-is and keeps working against the new backend.

Definition of Done:
- Heney answers using OpenAI; flipping one config value makes it answer using Gemini.
- Heney speaks with the OpenAI voice by default; premium voice flag switches to ElevenLabs.
- All 7 old skills work through LangGraph (spot-check each by voice).
- A test irreversible tool asks "should I do it?" and only acts on yes.
- Voice conversation on your phone works end to end exactly as before.

## PHASE 2 — RAG (first sponsor-facing feature)

Goal: upload a document, then ask Heney anything about it by voice or text.

Build:
1. pgvector enabled in Supabase; documents + chunks tables with RLS per user.
2. Upload endpoint (PDF, DOCX, TXT to start): extract text, chunk, embed with the ONE
   chosen OpenAI embedding model, store.
3. Retrieval tool in LangGraph: for document questions, retrieve top chunks and answer
   grounded in them, citing the document name.
4. Simple frontend: upload button, list of your documents, delete document.
5. Guardrails: file size limit, per-user document quota, uploads logged to tool_runs.

Definition of Done:
- Upload a 20+ page PDF on your phone, ask three questions by voice, get grounded
  answers that reference the document.
- Ask about something NOT in the document; Heney says it is not in the document rather
  than inventing an answer.
- User B cannot see or query User A's documents.

## PHASE 3 — Email (Gmail)

Goal: Heney reads, triages, drafts, and sends email with confirmation.

Build:
1. Google OAuth flow (per user) with Gmail scopes; tokens stored encrypted server-side.
2. LangGraph tools: search inbox, summarize thread, "anything important today?" triage,
   draft reply, compose new, send (irreversible: uses the confirmation pattern).
3. Upgrade the daily brief to include top unread email summaries.

Definition of Done:
- "Heney, anything important in my inbox?" returns a spoken triage of real email.
- "Email [name] that I'll join by 3" produces a draft, reads it back, sends only on
  yes, and the send appears in tool_runs and in Gmail's Sent folder.

## PHASE 4 — WhatsApp Messaging

Goal: voice-commanded WhatsApp sends, on a compliant foundation.

Build:
0. DESIGN DECISION FIRST (do not skip): choose the official WhatsApp Cloud/Business
   API route versus unofficial libraries (Baileys, Evolution API). Unofficial routes
   violate WhatsApp ToS and risk permanent number bans; unacceptable default for a
   sponsored product. Prototype privately if needed, but the shipped path must be
   defensible.
1. Contact resolution: "send David..." resolves a saved contact, asks when ambiguous.
2. Send tool (irreversible: confirmation pattern), plus delivery status feedback.

Definition of Done:
- "Send [contact] a WhatsApp that I'm 10 minutes late" works end to end with
  confirmation, and the chosen integration route is documented in HENEY_DECISIONS.md.

## PHASE 5 — Social Posting + Content Calendar

Goal: Heney generates, schedules, and publishes content.

Build:
1. Platform connections in order of API friendliness: LinkedIn and X first, Instagram
   Business next, TikTok last (API access is limited).
2. Content calendar stored in Supabase (themes per weekday, e.g. Mon AI tips, Tue
   career...); Heney generates drafts from the calendar.
3. Preview and approve flow (posting is irreversible: confirmation pattern), plus
   scheduled posting via a backend scheduler, with results logged to tool_runs.

Definition of Done:
- "Post today's AI tip to LinkedIn" generates, previews, and publishes on approval.
- A scheduled post publishes at its set time with no interaction, and notifies you.

## PHASE 6 — Proactive Assistant Layer

Goal: Heney stops only reacting and starts initiating. (Features from the backlog.)

Build:
1. Proactive morning briefing: at a user-set time, Heney speaks first: calendar,
   weather, top emails, reminders due. (Push/notification constraints of the PWA
   apply; deliver on app open if push is unavailable.)
2. Real calendar scheduling on calendar_events: "find 30 minutes with David next week."
3. Recurring routines engine: user-defined automations like "every Friday, summarize
   my week and email it to me" (scheduler + LangGraph runs).
4. Meeting / voice note summarization: record or upload audio, get summary + action
   items pushed into reminders.

Definition of Done:
- The morning brief arrives daily without being asked.
- One recurring routine you define runs on schedule twice in a row without touching it.

## PHASE 7 — Vision & Expansion Pack

Goal: the differentiators. Order within this phase is set by sponsor feedback and usage.

Candidates:
- Camera vision: identify objects, read documents, explain charts, "scan this food."
- Expense and receipt capture: photograph a receipt, extract merchant/amount/date,
  monthly summaries.
- Web research with cited sources and a spoken summary.
- Multi-language voice (including Pidgin / Yoruba) as a market differentiator.
- Desktop/browser control (open apps, automate browser tasks): note this requires a
  local agent beyond the PWA; scope it as its own mini-project when its turn comes.

## PHASE 8 — Scale & Native

Goal: growth infrastructure once traction is proven.

- Vercel Pro (commercial use), paid Supabase/Railway tiers as limits approach.
- Capacitor wrap for Android and iOS app store presence.
- Usage analytics, cost-per-user dashboard, premium tier (e.g. ElevenLabs voice).
- Test coverage on the voice pipeline BEFORE any refactor of App.jsx or the timing
  constants; then break up App.jsx (1743 lines), server.js, and memory.js.

---

## Sequence at a glance

0. Harden (auth, CORS, rate limits, tool_runs, CI)
1. OpenAI switch + LangGraph spine + confirmation pattern
2. RAG
3. Gmail
4. WhatsApp (decision first)
5. Social + content calendar
6. Proactive layer (briefings, scheduling, routines, meeting notes)
7. Vision + expansion pack (receipts, research, languages, desktop control)
8. Scale + native apps

Rule of thumb for the sponsor: after Phase 2 you have a demo, after Phase 3 you have a
product, after Phase 6 you have an assistant.
