import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MEMORY_REVIEW_TIMEOUT_MS = Number(
  process.env.MEMORY_REVIEW_TIMEOUT_MS || 10000
);
const GEMINI_QUOTA_MESSAGE =
  "I’m temporarily out of AI requests for now. Your reminders and saved information are still safe. Try again later.";

if (!GEMINI_API_KEY) {
  console.error(
    "[voice-buddy] Missing GEMINI_API_KEY. Copy .env.example to .env and add your key."
  );
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());

// Simple health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: GEMINI_MODEL });
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
    details.includes("too many requests")
  );
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
        .json({ error: "Server is missing GEMINI_API_KEY." });
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
 *   memoryContext?: string
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

    const { message, history = [], memoryContext = "" } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "A non-empty 'message' is required." });
    }

    // Convert chat history into Gemini's content format.
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

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction:
          "You are Heney, a friendly and concise personal voice assistant. " +
          "Keep answers natural and easy to read aloud. Avoid heavy markdown formatting." +
          memoryInstruction,
      },
    });

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
        reply: GEMINI_QUOTA_MESSAGE,
        degraded: true,
        reason: "gemini-quota",
      });
    }

    res
      .status(500)
      .json({ error: "Failed to get a response from Gemini.", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[voice-buddy] Backend running on http://localhost:${PORT}`);
});
