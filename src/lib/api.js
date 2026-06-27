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

export async function transcribeSpeech(audioBlob) {
  const formData = new FormData();
  const extension = audioBlob.type.includes("mp4")
    ? "mp4"
    : audioBlob.type.includes("mpeg")
    ? "mp3"
    : "webm";
  formData.append("audio", audioBlob, `speech.${extension}`);

  const res = await fetch(apiUrl("/api/stt"), {
    method: "POST",
    body: formData,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `STT request failed (${res.status})`);
  }

  return data.transcript || "";
}

export async function synthesizeSpeech(text) {
  const res = await fetch(apiUrl("/api/tts"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `TTS request failed (${res.status})`);
  }

  return await res.blob();
}
