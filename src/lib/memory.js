import { supabase } from "./supabase.js";
import { reviewMessageForMemory } from "./api.js";

const STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "are",
  "at",
  "be",
  "but",
  "do",
  "for",
  "from",
  "have",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "with",
  "you",
]);

const MEMORY_RECALL_PATTERNS = [
  /\bwhat do you remember\b/i,
  /\bwhat.*\babout me\b/i,
  /\bwhat project\b/i,
  /\bwhat am i (?:building|working on)\b/i,
  /\bworking on\b/i,
  /\bwhat church\b/i,
  /\bfavou?rite\b/i,
  /\bwhat did i tell you\b/i,
  /\bdo you remember\b/i,
];

function cleanValue(value) {
  return value.trim().replace(/[.?!,\s]+$/g, "").replace(/\s+/g, " ");
}

function sentence(text) {
  const cleaned = cleanValue(text);
  return cleaned ? `${cleaned}.` : "";
}

function keyPart(text) {
  return cleanValue(text)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function memoryKey(category, rawKey) {
  const key = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
  const [, suffix = key] = key.match(/^[a-z]+:(.+)$/) || [];
  const normalizedSuffix = keyPart(suffix);

  return normalizedSuffix ? `${category}:${normalizedSuffix}` : "";
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.replace(/(?:ing|ed|s)$/i, ""))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function tokenOverlapScore(left, right) {
  const leftWords = new Set(tokenize(left));
  const rightWords = new Set(tokenize(right));

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  const matches = [...leftWords].filter((word) => rightWords.has(word)).length;
  return matches / Math.min(leftWords.size, rightWords.size);
}

function recencyScore(updatedAt) {
  const updated = new Date(updatedAt || 0).getTime();
  if (!updated) return 0;

  const ageDays = (Date.now() - updated) / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / 90);
}

function normalizeReviewedMemories(review) {
  if (!review || review.shouldRemember !== true || !Array.isArray(review.memories)) {
    return [];
  }

  const allowedCategories = new Set([
    "personal",
    "preference",
    "project",
    "goal",
    "decision",
    "recurring",
  ]);

  return review.memories
    .map((memory) => {
      const category =
        typeof memory.category === "string"
          ? memory.category.trim().toLowerCase()
          : "";

      return {
        key: memoryKey(category, memory.key),
        value: typeof memory.value === "string" ? sentence(memory.value) : "",
        confidence:
          typeof memory.confidence === "number"
            ? Math.max(0, Math.min(1, memory.confidence))
            : 0.75,
        metadata: {
          category,
          detector: "gemini-review",
        },
      };
    })
    .filter(
      (memory, index, all) =>
        memory.key &&
        memory.value.length >= 8 &&
        allowedCategories.has(memory.metadata.category) &&
        all.findIndex((other) => other.key === memory.key) === index
    );
}

function memoryFromMyFact(subject, value) {
  const normalizedSubject = cleanValue(subject).toLowerCase();
  const normalizedValue = cleanValue(value);

  if (!normalizedSubject || !normalizedValue) return null;

  const category =
    /prefer|preference|favou?rite|like/.test(normalizedSubject)
      ? "preference"
      : /project|building|working/.test(normalizedSubject)
      ? "project"
      : /goal|plan|want/.test(normalizedSubject)
      ? "goal"
      : "personal";

  return {
    key: `${category}:${keyPart(normalizedSubject)}`,
    value: sentence(`My ${normalizedSubject} is ${normalizedValue}`),
    confidence: 0.92,
    metadata: { category, subject: normalizedSubject, detector: "my-fact" },
  };
}

export function detectMemoryCandidates(message) {
  const text = message.trim();
  const candidates = [];

  const remindMatch = text.match(
    /\bremind yourself that\s+(.+?)(?:[.?!]|$)/i
  );
  if (remindMatch) {
    const value = cleanValue(remindMatch[1]);
    if (value) {
      const preferenceMatch = value.match(/^i\s+(?:prefer|like|love)\s+(.+)$/i);
      const key =
        preferenceMatch && preferenceMatch[1]
          ? `preference:${keyPart(preferenceMatch[1])}`
          : `reminder:${keyPart(value)}`;

      candidates.push({
        key,
        value: sentence(value),
        confidence: 0.95,
        metadata: { category: "preference", detector: "remind-yourself" },
      });
    }
  }

  const myFactMatch = text.match(
    /\bmy\s+([a-z][a-z\s-]{1,40}?)\s+(?:is|are)\s+(.+?)(?:[.?!]|$)/i
  );
  if (myFactMatch) {
    const memory = memoryFromMyFact(myFactMatch[1], myFactMatch[2]);
    if (memory) candidates.push(memory);
  }

  const preferMatch = text.match(
    /\bi\s+(?:prefer|like|love)\s+(.+?)(?:[.?!]|$)/i
  );
  if (preferMatch) {
    const value = cleanValue(preferMatch[1]);
    if (value) {
      candidates.push({
        key: `preference:${keyPart(value)}`,
        value: sentence(`I prefer ${value}`),
        confidence: 0.9,
        metadata: { category: "preference", detector: "i-prefer" },
      });
    }
  }

  const projectMatch = text.match(
    /\bi(?:'m| am)\s+(building|working on|creating|developing)\s+(.+?)(?:[.?!]|$)/i
  );
  if (projectMatch) {
    const project = cleanValue(projectMatch[2]);
    if (project) {
      candidates.push({
        key: `project:${keyPart(project)}`,
        value: sentence(`I am ${projectMatch[1].toLowerCase()} ${project}`),
        confidence: 0.9,
        metadata: { category: "project", detector: "project" },
      });
    }
  }

  const goalMatch = text.match(
    /\b(?:my goal is|i want to|i plan to)\s+(.+?)(?:[.?!]|$)/i
  );
  if (goalMatch) {
    const goal = cleanValue(goalMatch[1]);
    if (goal) {
      candidates.push({
        key: `goal:${keyPart(goal)}`,
        value: sentence(`I want to ${goal}`),
        confidence: 0.86,
        metadata: { category: "goal", detector: "goal" },
      });
    }
  }

  return candidates.filter(
    (candidate, index, all) =>
      candidate.value.length >= 8 &&
      all.findIndex((other) => other.key === candidate.key) === index
  );
}

export function isMemoryRecallPrompt(message) {
  return MEMORY_RECALL_PATTERNS.some((pattern) => pattern.test(message));
}

export async function createMemory(userId, memory) {
  const { data, error } = await supabase
    .from("memories")
    .insert({
      user_id: userId,
      key: memory.key,
      value: memory.value,
      source_message_id: memory.sourceMessageId || null,
      confidence: memory.confidence || 1,
      metadata: memory.metadata || {},
    })
    .select("id,user_id,key,value,confidence,metadata,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateMemory(userId, key, updates) {
  const { data, error } = await supabase
    .from("memories")
    .update(updates)
    .eq("user_id", userId)
    .eq("key", key)
    .select("id,user_id,key,value,confidence,metadata,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function upsertMemory(userId, memory) {
  const { data, error } = await supabase
    .from("memories")
    .upsert(
      {
        user_id: userId,
        key: memory.key,
        value: memory.value,
        source_message_id: memory.sourceMessageId || null,
        confidence: memory.confidence || 1,
        metadata: memory.metadata || {},
      },
      { onConflict: "user_id,key" }
    )
    .select("id,user_id,key,value,confidence,metadata,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function getMemories(userId, limit = 50) {
  const { data, error } = await supabase
    .from("memories")
    .select("id,user_id,key,value,confidence,metadata,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

export async function deleteMemory(userId, key) {
  const { error } = await supabase
    .from("memories")
    .delete()
    .eq("user_id", userId)
    .eq("key", key);

  if (error) {
    throw error;
  }
}

export async function rememberFromMessage(userId, message, sourceMessageId) {
  const regexCandidates = detectMemoryCandidates(message);
  let memories = [];

  try {
    const review = await reviewMessageForMemory(message, regexCandidates);
    memories = normalizeReviewedMemories(review);
  } catch (error) {
    console.warn("Gemini memory review failed; using regex fallback.", error);
    memories = regexCandidates;
  }

  const existingMemories = memories.length ? await getMemories(userId) : [];
  const candidates = memories.map((candidate) => {
    const category = candidate.metadata?.category;
    const duplicate = existingMemories.find((memory) => {
      const sameCategory = memory.metadata?.category === category;
      const sameKey = memory.key === candidate.key;
      const similarValue =
        tokenOverlapScore(`${memory.key} ${memory.value}`, `${candidate.key} ${candidate.value}`) >=
        0.55;

      return sameKey || (sameCategory && similarValue);
    });

    return {
      ...candidate,
      key: duplicate?.key || candidate.key,
      sourceMessageId,
    };
  });

  if (candidates.length === 0) {
    return [];
  }

  return Promise.all(
    candidates.map((candidate) => upsertMemory(userId, candidate))
  );
}

export async function getRelevantMemories(userId, prompt, limit = 8) {
  const memories = await getMemories(userId);

  if (memories.length === 0) {
    return [];
  }

  if (isMemoryRecallPrompt(prompt)) {
    return memories.slice(0, limit);
  }

  const promptWords = new Set(tokenize(prompt));

  const relevant = memories
    .map((memory) => {
      const memoryWords = tokenize(
        `${memory.key} ${memory.value} ${memory.metadata?.category || ""}`
      );
      const lexicalScore = memoryWords.reduce(
        (total, word) => total + (promptWords.has(word) ? 1 : 0),
        0
      );
      const confidenceBoost = Number(memory.confidence || 0.7) * 0.5;
      const recentBoost = recencyScore(memory.updated_at) * 0.25;

      return {
        memory,
        lexicalScore,
        score: lexicalScore + confidenceBoost + recentBoost,
      };
    })
    .filter(({ lexicalScore }) => lexicalScore > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);

  return relevant.length > 0 ? relevant : memories.slice(0, Math.min(3, limit));
}

export function formatMemoriesForPrompt(memories) {
  if (!memories.length) {
    return "";
  }

  return memories
    .map((memory) => `- ${memory.value}`)
    .join("\n");
}

export function formatMemoryRecallReply(memories) {
  if (!memories.length) {
    return "I do not have much saved about you yet.";
  }

  const facts = memories
    .slice()
    .sort((a, b) => {
      const scoreA = Number(a.confidence || 0.7) + recencyScore(a.updated_at) * 0.3;
      const scoreB = Number(b.confidence || 0.7) + recencyScore(b.updated_at) * 0.3;
      return scoreB - scoreA;
    })
    .slice(0, 8)
    .map((memory) => memory.value.replace(/[.?!]+$/g, ""))
    .join("; ");

  return `I remember that ${facts}.`;
}
