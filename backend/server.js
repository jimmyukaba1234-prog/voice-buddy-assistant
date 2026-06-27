import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
const ELEVENLABS_TTS_MODEL =
  process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const MEMORY_REVIEW_TIMEOUT_MS = Number(
  process.env.MEMORY_REVIEW_TIMEOUT_MS || 10000
);
const GEMINI_QUOTA_MESSAGE =
  "I’m temporarily out of AI requests for now. Your reminders and saved information are still safe. Try again later.";

const FRIENDLY_GEMINI_QUOTA_MESSAGE =
  "My Gemini quota is exhausted for now. I can still help with reminders, weather, calculator, news, and saved information.";
const ELEVENLABS_QUOTA_MESSAGE =
  "My ElevenLabs voice credits are unavailable right now, so I will switch to browser voice.";

if (!GEMINI_API_KEY) {
  console.error(
    "[voice-buddy] Missing GEMINI_API_KEY. Copy .env.example to .env and add your key."
  );
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

function serviceErrorResponse(errorType, message, detail) {
  return {
    errorType,
    message,
    error: message,
    ...(detail ? { detail } : {}),
  };
}

function errorDetails(err, extra = []) {
  return [
    err?.message,
    err?.code,
    err?.name,
    err?.response?.statusText,
    err?.cause?.message,
    ...extra,
  ]
    .filter(Boolean)
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    .join(" ")
    .toLowerCase();
}

function isElevenLabsQuotaError(status, detail = "") {
  const text = errorDetails(null, [detail]);

  return (
    status === 401 ||
    status === 402 ||
    text.includes("invalid") ||
    text.includes("unauthorized") ||
    text.includes("payment_required") ||
    text.includes("paid_plan_required") ||
    text.includes("quota") ||
    text.includes("credit") ||
    text.includes("rate limit")
  );
}

function summarizeService(ok, detail = "") {
  return {
    ok,
    ...(detail ? { detail } : {}),
  };
}

async function checkGeminiAvailability() {
  if (!GEMINI_API_KEY) {
    return summarizeService(false, "Gemini API key is not configured.");
  }

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: "Reply with OK only." }] }],
      }),
      10000,
      "Gemini status check"
    );

    return summarizeService(Boolean(response.text), "Gemini responded.");
  } catch (err) {
    return summarizeService(
      false,
      isGeminiQuotaError(err)
        ? "Gemini quota or rate limit issue."
        : "Gemini status check failed."
    );
  }
}

async function checkElevenLabsTtsAvailability() {
  if (!ELEVENLABS_API_KEY) {
    return summarizeService(false, "ElevenLabs API key is not configured.");
  }

  return summarizeService(
    true,
    "ElevenLabs TTS is configured. Live TTS requests report quota, plan, key, and credit issues."
  );
}

async function checkElevenLabsSttAvailability() {
  if (!ELEVENLABS_API_KEY) {
    return summarizeService(false, "ElevenLabs API key is not configured.");
  }

  return summarizeService(
    true,
    "ElevenLabs STT is configured. Live STT requests report quota, plan, key, and credit issues."
  );
}

// Simple health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    server: "ok",
    geminiConfigured: Boolean(GEMINI_API_KEY),
    elevenLabsConfigured: Boolean(ELEVENLABS_API_KEY),
    model: GEMINI_MODEL,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/status", async (req, res) => {
  const [gemini, elevenLabsTts, elevenLabsStt] = await Promise.all([
    checkGeminiAvailability(),
    checkElevenLabsTtsAvailability(),
    checkElevenLabsSttAvailability(),
  ]);

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    backend: {
      ok: true,
      platform: process.env.RAILWAY_SERVICE_NAME ? "railway" : "local",
    },
    gemini: {
      configured: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL,
      ...gemini,
    },
    elevenLabs: {
      configured: Boolean(ELEVENLABS_API_KEY),
      ttsModel: ELEVENLABS_TTS_MODEL,
      sttModel: ELEVENLABS_STT_MODEL,
      tts: elevenLabsTts,
      stt: elevenLabsStt,
    },
    supabase: {
      configured: Boolean(
        process.env.SUPABASE_URL ||
          process.env.VITE_SUPABASE_URL ||
          process.env.SUPABASE_ANON_KEY ||
          process.env.SUPABASE_SERVICE_ROLE_KEY
      ),
    },
  });
});

app.post("/api/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json(
        serviceErrorResponse(
          "elevenlabs_unconfigured",
          "My ElevenLabs voice is not configured right now, so I will switch to browser voice."
        )
      );
    }

    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: "An audio file is required." });
    }

    const audioType = req.file.mimetype || "audio/webm";
    const audioName = req.file.originalname || "speech.webm";
    const formData = new FormData();
    formData.append("model_id", ELEVENLABS_STT_MODEL);
    formData.append(
      "file",
      new Blob([req.file.buffer], { type: audioType }),
      audioName
    );

    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail = data.detail || data.message || response.statusText;
      const errorType = isElevenLabsQuotaError(response.status, detail)
        ? "elevenlabs_quota"
        : "elevenlabs_error";
      const message =
        errorType === "elevenlabs_quota"
          ? ELEVENLABS_QUOTA_MESSAGE
          : "ElevenLabs STT request failed.";
      return res.status(response.status).json({
        ...serviceErrorResponse(errorType, message, detail),
      });
    }

    res.json({ transcript: (data.text || "").trim(), raw: data });
  } catch (err) {
    console.error("[voice-buddy] /api/stt error:", err);
    res
      .status(502)
      .json(serviceErrorResponse("elevenlabs_error", "Failed to transcribe audio.", err.message));
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json(
        serviceErrorResponse(
          "elevenlabs_unconfigured",
          "My ElevenLabs voice is not configured right now, so I will switch to browser voice."
        )
      );
    }

    const { text } = req.body || {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "A non-empty 'text' is required." });
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: text.trim(),
          model_id: ELEVENLABS_TTS_MODEL,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      const errorType = isElevenLabsQuotaError(response.status, detail)
        ? "elevenlabs_quota"
        : "elevenlabs_error";
      const message =
        errorType === "elevenlabs_quota"
          ? ELEVENLABS_QUOTA_MESSAGE
          : "ElevenLabs TTS request failed.";
      return res
        .status(response.status)
        .json(serviceErrorResponse(errorType, message, detail));
    }

    const audio = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", response.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (err) {
    console.error("[voice-buddy] /api/tts error:", err);
    res
      .status(502)
      .json(serviceErrorResponse("elevenlabs_error", "Failed to generate speech.", err.message));
  }
});

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractRssTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1] || "");
}

function newsQueryForTopic(topic = "") {
  const normalized = topic.toLowerCase();

  if (normalized.includes("nigeria")) return "Nigeria news";
  if (normalized.includes("ai")) return "artificial intelligence news";
  if (normalized.includes("tech")) return "technology news";
  if (normalized.includes("business")) return "business news";
  if (normalized.includes("sports")) return "sports news";
  return "top news today";
}

app.get("/api/news", async (req, res) => {
  try {
    const topic = typeof req.query.topic === "string" ? req.query.topic : "";
    const query = newsQueryForTopic(topic);
    const url =
      "https://news.google.com/rss/search" +
      `?q=${encodeURIComponent(query)}` +
      "&hl=en-US&gl=US&ceid=US:en";

    const response = await fetch(url, {
      headers: {
        "User-Agent": "HeneyAssistant/1.1",
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `News request failed (${response.status}).` });
    }

    const xml = await response.text();
    const articles = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .slice(0, 5)
      .map((match) => {
        const item = match[1];
        const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

        return {
          title: extractRssTag(item, "title"),
          source: decodeXml(sourceMatch?.[1] || "Google News"),
          publishedAt: extractRssTag(item, "pubDate"),
        };
      })
      .filter((article) => article.title);

    res.json({ topic: query, articles });
  } catch (err) {
    console.error("[voice-buddy] /api/news error:", err);
    res.status(500).json({ error: "Failed to fetch news.", detail: err.message });
  }
});

function parseStrictJson(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Gemini returned an empty memory review.");
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Gemini memory review was not strict JSON.");
  }

  return JSON.parse(trimmed);
}

function normalizeMemoryReview(review) {
  if (!review || typeof review !== "object") {
    throw new Error("Memory review was not an object.");
  }

  const shouldRemember = review.shouldRemember === true;
  const memories = Array.isArray(review.memories) ? review.memories : [];
  const allowedCategories = new Set([
    "personal",
    "preference",
    "project",
    "goal",
    "decision",
    "recurring",
  ]);

  return {
    shouldRemember,
    memories: shouldRemember
      ? memories
          .map((memory) => ({
            key: typeof memory.key === "string" ? memory.key.trim() : "",
            value: typeof memory.value === "string" ? memory.value.trim() : "",
            category:
              typeof memory.category === "string"
                ? memory.category.trim().toLowerCase()
                : "",
            confidence:
              typeof memory.confidence === "number"
                ? Math.max(0, Math.min(1, memory.confidence))
                : 0.75,
          }))
          .filter(
            (memory) =>
              memory.key &&
              memory.value &&
              allowedCategories.has(memory.category)
          )
      : [],
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function isGeminiQuotaError(err) {
  const status =
    err?.status ||
    err?.statusCode ||
    err?.response?.status ||
    err?.cause?.status ||
    err?.cause?.response?.status;
  const details = [
    err?.message,
    err?.code,
    err?.name,
    err?.response?.statusText,
    err?.cause?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    status === 429 ||
    details.includes("429") ||
    details.includes("quota") ||
    details.includes("resource_exhausted") ||
    details.includes("rate limit") ||
    details.includes("too many requests")
  );
}

function buildChatRequest(body = {}) {
  const {
    message,
    history = [],
    memoryContext = "",
    voiceMode = false,
  } = body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    const err = new Error("A non-empty 'message' is required.");
    err.status = 400;
    throw err;
  }

  const contents = [
    ...history
      .filter((m) => m && typeof m.text === "string" && m.text.trim())
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }],
      })),
    { role: "user", parts: [{ text: message }] },
  ];

  const memoryInstruction =
    typeof memoryContext === "string" && memoryContext.trim()
      ? "\n\nLong-term memories about the user:\n" +
        memoryContext.trim() +
        "\nUse long-term memories naturally when they are relevant. " +
        "Do not mention memory records unless the user explicitly asks. " +
        "If the user asks what you remember, summarize naturally. " +
        "Never say 'according to your stored memory' unless necessary."
      : "";
  const voiceInstruction = voiceMode
    ? " Voice mode is active: answer in 1 to 3 short, natural sentences unless the user asks for details. Avoid long bullet lists, tables, and dense formatting."
    : "";

  return {
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction:
        "You are Heney, a friendly and concise personal voice assistant. " +
        "Keep answers natural and easy to read aloud. Avoid heavy markdown formatting." +
        voiceInstruction +
        memoryInstruction,
    },
  };
}

/**
 * POST /api/memory-review
 * Body: { message: string, candidates?: [{ key, value, confidence, metadata }] }
 * Returns: { shouldRemember: boolean, memories: [...] }
 */
app.post("/api/memory-review", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res
        .status(500)
        .json(
          serviceErrorResponse(
            "gemini_unconfigured",
            "Gemini is not configured on the backend right now."
          )
        );
    }

    const { message, candidates = [] } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "A non-empty 'message' is required." });
    }

    const candidateLines = Array.isArray(candidates)
      ? candidates
          .filter((candidate) => candidate && typeof candidate.value === "string")
          .map(
            (candidate) =>
              `- key: ${candidate.key || ""}; value: ${candidate.value}; category: ${
                candidate.metadata?.category || ""
              }`
          )
          .join("\n")
      : "";

    const response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Review this user message for long-term memory-worthy information.\n\n" +
                  `User message: ${JSON.stringify(message.trim())}\n\n` +
                  "Regex first-pass candidates, if any:\n" +
                  (candidateLines || "- none") +
                  "\n\nReturn strict JSON only in this exact shape:\n" +
                  '{"shouldRemember":true,"memories":[{"key":"preference:dark-mode","value":"Jimmy prefers dark mode.","category":"preference","confidence":0.9}]}\n\n' +
                  "Store only personal facts, preferences, ongoing projects, long-term goals, important decisions, and recurring information. " +
                  "Do not store casual conversation, temporary comments, greetings, or one-off questions. " +
                  "Use stable lowercase kebab-case keys prefixed by category, such as personal:name, preference:dark-mode, project:voice-buddy, goal:learn-react, decision:use-supabase, recurring:weekly-report. " +
                  "Write values as natural third-person facts about the user. If the user's name is known from the message, use it; otherwise use 'The user'. " +
                  "If nothing should be remembered, return {\"shouldRemember\":false,\"memories\":[]}.",
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          systemInstruction:
            "You are a strict long-term memory extraction reviewer. Return JSON only, with no markdown and no explanation.",
        },
      }),
      MEMORY_REVIEW_TIMEOUT_MS,
      "Gemini memory review"
    );

    const review = normalizeMemoryReview(parseStrictJson(response.text));
    res.json(review);
  } catch (err) {
    console.error("[voice-buddy] /api/memory-review error:", err);
    res.status(502).json({
      error: "Failed to review memory with Gemini.",
      detail: err.message,
    });
  }
});

/**
 * POST /api/chat
 * Body: {
 *   message: string,
 *   history?: [{ role: "user" | "assistant", text: string }],
 *   memoryContext?: string,
 *   voiceMode?: boolean
 * }
 * Returns: { reply: string }
 */
app.post("/api/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res
        .status(500)
        .json({ error: "Server is missing GEMINI_API_KEY." });
    }

    const response = await ai.models.generateContent(buildChatRequest(req.body));

    const reply = response.text?.trim();

    if (!reply) {
      return res
        .status(502)
        .json({ error: "Gemini returned an empty response." });
    }

    res.json({ reply });
  } catch (err) {
    console.error("[voice-buddy] /api/chat error:", err);

    if (isGeminiQuotaError(err)) {
      return res.json({
        reply: FRIENDLY_GEMINI_QUOTA_MESSAGE,
        errorType: "gemini_quota",
        message: FRIENDLY_GEMINI_QUOTA_MESSAGE,
        degraded: true,
        reason: "gemini-quota",
      });
    }

    res
      .status(err.status || 500)
      .json({ error: "Failed to get a response from Gemini.", detail: err.message });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res
        .status(500)
        .json(
          serviceErrorResponse(
            "gemini_unconfigured",
            "Gemini is not configured on the backend right now."
          )
        );
    }

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const response = await ai.models.generateContentStream(buildChatRequest(req.body));
    let fullText = "";

    for await (const chunk of response) {
      const text = chunk.text || "";
      if (!text) continue;

      fullText += text;
      res.write(`${JSON.stringify({ type: "chunk", text })}\n`);
    }

    res.write(`${JSON.stringify({ type: "done", reply: fullText.trim() })}\n`);
    res.end();
  } catch (err) {
    console.error("[voice-buddy] /api/chat/stream error:", err);

    if (isGeminiQuotaError(err)) {
      res.write(
        `${JSON.stringify({
          type: "done",
          reply: FRIENDLY_GEMINI_QUOTA_MESSAGE,
          errorType: "gemini_quota",
          message: FRIENDLY_GEMINI_QUOTA_MESSAGE,
          degraded: true,
          reason: "gemini-quota",
        })}\n`
      );
      return res.end();
    }

    if (!res.headersSent) {
      return res
        .status(err.status || 500)
        .json({ error: "Failed to stream a response from Gemini.", detail: err.message });
    }

    res.write(
      `${JSON.stringify({
        type: "error",
        error: "Failed to stream a response from Gemini.",
        detail: err.message,
      })}\n`
    );
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[voice-buddy] Backend running on http://localhost:${PORT}`);
});
