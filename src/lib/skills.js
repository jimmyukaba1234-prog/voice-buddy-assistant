import { getCalculatorReply, isCalculatorPrompt } from "./calculator.js";
import {
  getConversationRecallReply,
  isConversationRecallPrompt,
} from "./conversationRecall.js";
import {
  formatMemoryRecallReply,
  getMemories,
  isMemoryRecallPrompt,
} from "./memory.js";
import { getDailyBriefReply, isDailyBriefPrompt } from "./dailyBrief.js";
import { getNewsReply, isNewsPrompt } from "./news.js";
import { handleReminderPrompt, isReminderPrompt } from "./reminders.js";
import {
  extractWeatherLocation,
  findKnownWeatherLocation,
  getWeatherReply,
  isWeatherPrompt,
} from "./weather.js";
import { logToolRun } from "./toolRunLog.js";

async function weatherReply(userId, message) {
  const weatherRequest = extractWeatherLocation(message);
  let location = weatherRequest.location;

  if (weatherRequest.needsKnownLocation) {
    try {
      location = findKnownWeatherLocation(await getMemories(userId));
    } catch (error) {
      console.warn("Could not read location memory for weather:", error);
    }
  }

  return getWeatherReply(message, location);
}

export async function getLocalSkillReply({ userId, message, currentMessageId }) {
  if (isCalculatorPrompt(message)) {
    try {
      const reply = getCalculatorReply(message);
      logToolRun("calculator", message, "succeeded");
      return reply;
    } catch {
      logToolRun("calculator", message, "failed");
      return "";
    }
  }

  if (isDailyBriefPrompt(message)) {
    const reply = await getDailyBriefReply(userId);
    logToolRun("daily-brief", message, "succeeded");
    return reply;
  }

  if (isReminderPrompt(message)) {
    const reply = await handleReminderPrompt(userId, message);
    logToolRun("reminders", message, "succeeded");
    return reply;
  }

  if (isWeatherPrompt(message)) {
    try {
      const reply = await weatherReply(userId, message);
      logToolRun("weather", message, "succeeded");
      return reply;
    } catch {
      logToolRun("weather", message, "failed");
      return "I could not reach the weather service right now. Try again in a moment.";
    }
  }

  if (isNewsPrompt(message)) {
    try {
      const reply = await getNewsReply(message);
      logToolRun("news", message, "succeeded");
      return reply;
    } catch {
      logToolRun("news", message, "failed");
      return "I could not reach the news source right now. Try again in a moment.";
    }
  }

  if (isConversationRecallPrompt(message)) {
    const reply = await getConversationRecallReply(userId, message, currentMessageId);
    logToolRun("conversation-recall", message, "succeeded");
    return reply;
  }

  if (isMemoryRecallPrompt(message)) {
    const memories = await getMemories(userId);
    const reply = formatMemoryRecallReply(memories);
    logToolRun("memory-recall", message, "succeeded");
    return reply;
  }

  return "";
}
