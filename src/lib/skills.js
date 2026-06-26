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
      return getCalculatorReply(message);
    } catch {
      return "";
    }
  }

  if (isDailyBriefPrompt(message)) {
    return getDailyBriefReply(userId);
  }

  if (isReminderPrompt(message)) {
    return handleReminderPrompt(userId, message);
  }

  if (isWeatherPrompt(message)) {
    try {
      return await weatherReply(userId, message);
    } catch {
      return "I could not reach the weather service right now. Try again in a moment.";
    }
  }

  if (isNewsPrompt(message)) {
    try {
      return await getNewsReply(message);
    } catch {
      return "I could not reach the news source right now. Try again in a moment.";
    }
  }

  if (isConversationRecallPrompt(message)) {
    return getConversationRecallReply(userId, message, currentMessageId);
  }

  if (isMemoryRecallPrompt(message)) {
    const memories = await getMemories(userId);
    return formatMemoryRecallReply(memories);
  }

  return "";
}
