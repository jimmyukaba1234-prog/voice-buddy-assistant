const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/g, "");

export function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

function apiError(data, fallbackMessage, status) {
  const err = new Error(data.message || data.error || fallbackMessage);
  err.status = status;
  err.errorType = data.errorType || "";
  err.data = data;
  return err;
}

export async function fetchServiceStatus() {
  const res = await fetch(apiUrl("/api/status"));
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw apiError(data, `Status request failed (${res.status})`, res.status);
  }

  return data;
}

// Sends the current message plus history to the backend and returns the reply text.
export async function sendChatMessage(
  message,
  history,
  memoryContext = "",
  options = {}
) {
  const res = await fetch(apiUrl("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      memoryContext,
      voiceMode: options.voiceMode === true,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw apiError(data, `Request failed (${res.status})`, res.status);
  }

  if (data.errorType) {
    const err = apiError(data, data.reply || data.message || "Chat service issue.", res.status);
    err.reply = data.reply || data.message || "";
    throw err;
  }

  return data.reply;
}

export async function streamChatMessage(
  message,
  history,
  memoryContext = "",
  options = {},
  onChunk = () => {}
) {
  const res = await fetch(apiUrl("/api/chat/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      memoryContext,
      voiceMode: options.voiceMode === true,
    }),
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw apiError(data, `Stream request failed (${res.status})`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);

      if (event.type === "chunk") {
        reply += event.text || "";
        onChunk(event.text || "");
      } else if (event.type === "done") {
        if (event.errorType) {
          const err = apiError(event, event.reply || event.message || "Stream degraded.", res.status);
          err.reply = event.reply || event.message || "";
          throw err;
        }
        return event.reply || reply;
      } else if (event.type === "error") {
        throw apiError(event, "Stream failed.", res.status);
      }
    }

    if (done) break;
  }

  return reply;
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
    throw apiError(data, `STT request failed (${res.status})`, res.status);
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
    throw apiError(data, `TTS request failed (${res.status})`, res.status);
  }

  return await res.blob();
}
