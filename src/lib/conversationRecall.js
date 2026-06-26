import { supabase } from "./supabase.js";

const RECALL_PATTERNS = [
  /\bwhat did we (?:discuss|decide|talk about)\b/i,
  /\bwhat was my idea\b/i,
  /\bwhat did i say\b/i,
  /\bdo you remember (?:what we|when we|our conversation)\b/i,
  /\bregarding\b/i,
  /\babout the\b/i,
];

const STOP_WORDS = new Set([
  "about",
  "what",
  "when",
  "where",
  "which",
  "that",
  "this",
  "with",
  "were",
  "was",
  "did",
  "discuss",
  "decide",
  "talk",
  "regarding",
  "yesterday",
  "today",
  "idea",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function dateRangeForPrompt(prompt) {
  const lower = prompt.toLowerCase();
  const start = new Date();
  const end = new Date();

  if (lower.includes("yesterday")) {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - 1);
    end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (lower.includes("today")) {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  return null;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function extractSnippet(text, terms) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 180) return clean;

  const lower = clean.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)[0];

  const start = Math.max(0, (index || 0) - 70);
  return `${start > 0 ? "..." : ""}${clean.slice(start, start + 180).trim()}...`;
}

export function isConversationRecallPrompt(message) {
  return RECALL_PATTERNS.some((pattern) => pattern.test(message || ""));
}

export async function getConversationRecallReply(userId, prompt, currentMessageId) {
  const terms = tokenize(prompt);
  const dateRange = dateRangeForPrompt(prompt);

  let query = supabase
    .from("messages")
    .select("id,conversation_id,role,content,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(150);

  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end);
  }

  const { data, error } = await query;
  if (error) throw error;

  const messages = (data || []).filter((message) => message.id !== currentMessageId);

  if (messages.length === 0) {
    return dateRange
      ? "I do not see any saved conversation from that time."
      : "I do not see that in our saved conversations yet.";
  }

  const ranked = messages
    .map((message) => {
      const text = `${message.role} ${message.content}`.toLowerCase();
      const score =
        terms.length === 0
          ? 1
          : terms.reduce((total, term) => total + (text.includes(term) ? 2 : 0), 0);
      const recencyBoost = Math.max(
        0,
        1 - (Date.now() - new Date(message.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30)
      );

      return { message, score: score + recencyBoost };
    })
    .filter(({ score }) => score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (ranked.length === 0) {
    return "I could not find a clear match in our saved conversations.";
  }

  const snippets = ranked
    .map(({ message }) => `${formatDate(message.created_at)}: ${extractSnippet(message.content, terms)}`)
    .join(" ");

  return `From our saved conversations, this is what I found: ${snippets}`;
}
