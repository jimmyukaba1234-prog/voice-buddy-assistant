import { getMemories } from "./memory.js";
import { getNewsReply } from "./news.js";
import { getTodaysReminders, formatReminderTime } from "./reminders.js";
import { findKnownWeatherLocation, getWeatherReply } from "./weather.js";

const DAILY_BRIEF_PATTERNS = [
  /^\s*good morning\b/i,
  /\bwhat do i have today\b/i,
  /\bgive me my daily brief\b/i,
  /\bdaily brief\b/i,
  /\bwhat are my plans today\b/i,
  /\bplans today\b/i,
];

function cleanSentence(value) {
  return (value || "").replace(/[.?!]+$/g, "").trim();
}

function memoryLooksLikePlan(memory) {
  const haystack = `${memory.key || ""} ${memory.value || ""} ${
    memory.metadata?.category || ""
  }`.toLowerCase();

  return /\b(plan|goal|project|meeting|task|todo|decision|recurring)\b/.test(
    haystack
  );
}

function summarizeReminders(reminders) {
  if (!reminders.length) return "";

  return `For today, you have ${reminders
    .slice(0, 5)
    .map((reminder) => `${reminder.title} at ${formatReminderTime(reminder.dueAt)}`)
    .join("; ")}.`;
}

function summarizePlans(memories) {
  const plans = memories
    .filter(memoryLooksLikePlan)
    .map((memory) => cleanSentence(memory.value))
    .filter(Boolean)
    .slice(0, 4);

  if (!plans.length) return "";

  return `Saved plans and priorities I have for you: ${plans.join("; ")}.`;
}

async function weatherBrief(memories) {
  const location = findKnownWeatherLocation(memories);

  if (!location) {
    return "";
  }

  try {
    return await getWeatherReply("weather today", location);
  } catch (error) {
    console.warn("Daily brief weather failed:", error);
    return "";
  }
}

async function newsBrief() {
  try {
    return await getNewsReply("top news");
  } catch (error) {
    console.warn("Daily brief news failed:", error);
    return "";
  }
}

export function isDailyBriefPrompt(message) {
  return DAILY_BRIEF_PATTERNS.some((pattern) => pattern.test(message || ""));
}

export async function getDailyBriefReply(userId) {
  const [reminders, memories] = await Promise.all([
    getTodaysReminders(userId),
    getMemories(userId, 50),
  ]);

  const reminderSummary = summarizeReminders(reminders);
  const planSummary = summarizePlans(memories);
  const weatherSummary = await weatherBrief(memories);
  const hasPersonalBriefData = Boolean(
    reminderSummary || planSummary || weatherSummary
  );

  if (!hasPersonalBriefData) {
    return "Good morning Jimmy. I don’t have any saved plans for today yet.";
  }

  const newsSummary = await newsBrief();
  const sections = [
    "Good morning Jimmy.",
    reminderSummary,
    planSummary,
    weatherSummary,
    newsSummary,
  ].filter(Boolean);

  return sections.join(" ");
}
