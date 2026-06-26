import { apiUrl } from "./api.js";

const NEWS_PATTERNS = [
  /\bwhat'?s happening today\b/i,
  /\bnews\b/i,
  /\bheadlines\b/i,
  /\bcurrent events\b/i,
];

function extractNewsTopic(message) {
  const text = (message || "").toLowerCase();

  if (/\bnigeria\b/.test(text)) return "Nigeria";
  if (/\b(ai|artificial intelligence)\b/.test(text)) return "AI";
  if (/\btech|technology\b/.test(text)) return "Technology";
  if (/\bbusiness\b/.test(text)) return "Business";
  if (/\bsports\b/.test(text)) return "Sports";

  return "top news";
}

export function isNewsPrompt(message) {
  return NEWS_PATTERNS.some((pattern) => pattern.test(message || ""));
}

export async function getNewsReply(message) {
  const topic = extractNewsTopic(message);
  const response = await fetch(apiUrl(`/api/news?topic=${encodeURIComponent(topic)}`));

  if (!response.ok) {
    throw new Error(`News request failed (${response.status})`);
  }

  const data = await response.json();
  const articles = (data.articles || []).filter((article) => article.title).slice(0, 4);

  if (articles.length === 0) {
    return `I could not find fresh ${topic === "top news" ? "headlines" : topic.toLowerCase() + " headlines"} right now.`;
  }

  const headlines = articles
    .map((article, index) => `${index + 1}. ${article.title} (${article.source || "News"})`)
    .join(" ");

  return topic === "top news"
    ? `Today's top headlines: ${headlines}`
    : `Today's ${topic} headlines: ${headlines}`;
}
