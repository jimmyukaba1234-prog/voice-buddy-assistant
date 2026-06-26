const BASIC_MATH_PATTERN = /^[\d\s+\-*/().%^]+$/;

function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(8))).replace(/\.0+$/, "");
}

function safeEvaluate(expression) {
  const normalized = expression.replace(/\^/g, "**");

  if (!BASIC_MATH_PATTERN.test(expression)) {
    throw new Error("Unsupported expression.");
  }

  const result = Function(`"use strict"; return (${normalized});`)();

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Invalid calculation.");
  }

  return result;
}

export function isCalculatorPrompt(message) {
  const text = (message || "").trim();

  return (
    BASIC_MATH_PATTERN.test(text) ||
    /\b\d+(?:\.\d+)?\s*%\s+of\s+\d+(?:\.\d+)?\b/i.test(text) ||
    /\bsquare root of\s+\d+(?:\.\d+)?\b/i.test(text) ||
    /\bsqrt\s*\(?\s*\d+(?:\.\d+)?\s*\)?/i.test(text) ||
    /\b\d+(?:\.\d+)?\s+[a-z]{3}\s+to\s+[a-z]{3}\b/i.test(text)
  );
}

export function getCalculatorReply(message) {
  const text = (message || "").trim();

  const fxMatch = text.match(/\b(\d+(?:\.\d+)?)\s+([a-z]{3})\s+to\s+([a-z]{3})\b/i);
  if (fxMatch) {
    return "Currency conversion is not available yet because no exchange-rate source is configured.";
  }

  const percentMatch = text.match(/\b(\d+(?:\.\d+)?)\s*%\s+of\s+(\d+(?:\.\d+)?)\b/i);
  if (percentMatch) {
    const percentage = Number(percentMatch[1]);
    const amount = Number(percentMatch[2]);
    const result = (percentage / 100) * amount;
    return `${formatNumber(percentage)}% of ${formatNumber(amount)} is ${formatNumber(result)}.`;
  }

  const sqrtMatch =
    text.match(/\bsquare root of\s+(\d+(?:\.\d+)?)\b/i) ||
    text.match(/\bsqrt\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/i);
  if (sqrtMatch) {
    const value = Number(sqrtMatch[1]);
    return `The square root of ${formatNumber(value)} is ${formatNumber(Math.sqrt(value))}.`;
  }

  const expression = text.replace(/\s+/g, "");
  const result = safeEvaluate(expression);
  return `${text} = ${formatNumber(result)}.`;
}
