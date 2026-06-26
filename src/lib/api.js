const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/g, "");

export function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

// Sends the current message plus history to the backend and returns the reply text.
export async function sendChatMessage(message, history, memoryContext = "") {
  const res = await fetch(apiUrl("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, memoryContext }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data.reply;
}

export async function reviewMessageForMemory(message, candidates = []) {
  const res = await fetch(apiUrl("/api/memory-review"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, candidates }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Memory review failed (${res.status})`);
  }

  return data;
}
