import { supabase } from "./supabase.js";

const REMINDER_PATTERNS =
  /\b(remind me|set a reminder|reminder|my reminders|list reminders)\b/i;
const TOMORROW_PLAN_PATTERNS = [
  /\btomorrow\s+i\s+(?:need|have|must|should|want|plan)\s+to\b/i,
  /\bmy\s+plan\s+tomorrow\s+is\b/i,
  /\btomorrow\s+i\s+have\b/i,
  /\bremind\s+me\s+tomorrow\b/i,
];

function toReminder(row) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    status: row.status,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

export function formatReminderTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function startOfLocalDay(date = new Date()) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfLocalDay(date = new Date()) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function cleanTitle(value) {
  return (value || "")
    .trim()
    .replace(/\s+(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$/i, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ");
}

function applyTimeFromMessage(dueAt, message) {
  const text = (message || "").toLowerCase();
  const timeMatch = text.match(/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);

  if (!timeMatch) {
    return dueAt;
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = timeMatch[3];

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  dueAt.setHours(hour, minute, 0, 0);

  if (!text.includes("tomorrow") && dueAt.getTime() < Date.now()) {
    dueAt.setDate(dueAt.getDate() + 1);
  }

  return dueAt;
}

function parseReminderRequest(message) {
  const text = (message || "").trim();
  const reminderMatch = text.match(
    /\b(?:remind me to|set a reminder to|reminder to)\s+(.+?)(?:\s+(?:at|by|on|tomorrow|today|tonight)\b.*|[.?!]?$)/i
  );

  if (!reminderMatch) {
    return null;
  }

  const title = cleanTitle(reminderMatch[1]);
  const lower = text.toLowerCase();
  const dueAt = new Date();

  if (lower.includes("tomorrow")) {
    dueAt.setDate(dueAt.getDate() + 1);
    dueAt.setHours(9, 0, 0, 0);
  } else if (lower.includes("tonight")) {
    dueAt.setHours(20, 0, 0, 0);
  } else {
    dueAt.setHours(dueAt.getHours() + 1, 0, 0, 0);
  }

  return {
    title,
    dueAt: applyTimeFromMessage(dueAt, text).toISOString(),
    metadata: { source: "reminder" },
  };
}

function parseTomorrowPlan(message) {
  const text = (message || "").trim();
  const lower = text.toLowerCase();

  if (!TOMORROW_PLAN_PATTERNS.some((pattern) => pattern.test(text))) {
    return null;
  }

  const planText =
    text.match(/\btomorrow\s+i\s+need\s+to\s+(.+?)(?:[.?!]|$)/i)?.[1] ||
    text.match(/\btomorrow\s+i\s+(?:have|must|should|want|plan)\s+to\s+(.+?)(?:[.?!]|$)/i)?.[1] ||
    text.match(/\bmy\s+plan\s+tomorrow\s+is\s+(.+?)(?:[.?!]|$)/i)?.[1] ||
    text.match(/\btomorrow\s+i\s+have\s+(.+?)(?:[.?!]|$)/i)?.[1] ||
    text.match(/\bremind\s+me\s+tomorrow\s+(?:to\s+)?(.+?)(?:[.?!]|$)/i)?.[1];

  const title = cleanTitle(planText);

  if (!title) {
    return null;
  }

  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + 1);
  dueAt.setHours(9, 0, 0, 0);

  return {
    title,
    dueAt: applyTimeFromMessage(dueAt, lower).toISOString(),
    metadata: { source: "tomorrow-plan", type: "plan" },
  };
}

export function isReminderPrompt(message) {
  return (
    REMINDER_PATTERNS.test(message || "") ||
    TOMORROW_PLAN_PATTERNS.some((pattern) => pattern.test(message || ""))
  );
}

export async function createReminder(userId, title, dueAt, metadata = {}) {
  const { data, error } = await supabase
    .from("reminders")
    .insert({
      user_id: userId,
      title,
      due_at: dueAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      metadata,
    })
    .select("id,title,notes,due_at,status,metadata,created_at")
    .single();

  if (error) throw error;
  return toReminder(data);
}

export async function getPendingReminders(userId, limit = 10) {
  const { data, error } = await supabase
    .from("reminders")
    .select("id,title,notes,due_at,status,metadata,created_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data || []).map(toReminder);
}

export async function getRemindersDueBetween(userId, start, end, limit = 20) {
  const { data, error } = await supabase
    .from("reminders")
    .select("id,title,notes,due_at,status,metadata,created_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gte("due_at", start.toISOString())
    .lte("due_at", end.toISOString())
    .order("due_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data || []).map(toReminder);
}

export async function getTodaysReminders(userId) {
  return getRemindersDueBetween(userId, startOfLocalDay(), endOfLocalDay());
}

export async function handleReminderPrompt(userId, message) {
  const text = (message || "").trim();

  if (/\b(list|show|what are|my reminders)\b/i.test(text)) {
    const reminders = await getPendingReminders(userId);
    return reminders.length === 0
      ? "You do not have any pending reminders."
      : `Your pending reminders are: ${reminders
          .slice(0, 5)
          .map((reminder) => `${reminder.title} on ${formatReminderTime(reminder.dueAt)}`)
          .join("; ")}.`;
  }

  const plan = parseTomorrowPlan(text);
  if (plan?.title) {
    const saved = await createReminder(userId, plan.title, plan.dueAt, plan.metadata);
    return `Saved for tomorrow: ${saved.title} on ${formatReminderTime(saved.dueAt)}.`;
  }

  const reminder = parseReminderRequest(text);
  if (!reminder?.title) {
    return "What should I remind you about?";
  }

  const saved = await createReminder(
    userId,
    reminder.title,
    reminder.dueAt,
    reminder.metadata
  );
  return `Reminder set: ${saved.title} on ${formatReminderTime(saved.dueAt)}.`;
}
