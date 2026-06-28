import { useEffect, useRef, useState } from "react";
import { AuthForm } from "./auth/AuthForm.jsx";
import { useAuth } from "./auth/AuthProvider.jsx";
import {
  fetchServiceStatus,
  sendChatMessage,
  streamChatMessage,
  synthesizeSpeech,
  transcribeSpeech,
} from "./lib/api.js";
import {
  createConversation,
  generateConversationTitle,
  loadMostRecentConversation,
  saveMessage,
  updateConversation,
} from "./lib/conversations.js";
import {
  formatMemoriesForPrompt,
  getRelevantMemories,
  rememberFromMessage,
} from "./lib/memory.js";
import { getLocalSkillReply } from "./lib/skills.js";

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

const speechSupported = Boolean(SpeechRecognition);
const speechSupportLabel =
  typeof window === "undefined"
    ? "Unavailable"
    : window.SpeechRecognition
    ? "SpeechRecognition"
    : window.webkitSpeechRecognition
    ? "webkitSpeechRecognition"
    : "Not supported";
const showVoiceDebug = import.meta.env.VITE_SHOW_VOICE_DEBUG === "true";

const configuredTurnEndGraceMs = Number(import.meta.env.VITE_TURN_END_GRACE_MS);
const TURN_END_GRACE_MS =
  Number.isFinite(configuredTurnEndGraceMs) && configuredTurnEndGraceMs >= 500
    ? configuredTurnEndGraceMs
    : 1000;
const FALLBACK_SILENCE_DELAY_MS = 2200;
const SELF_INTERRUPT_GUARD_MS = 450;
const BRIDGE_PHRASES = ["On it.", "One moment.", "Let me check."];
const ASSISTANT_NAME = "Heney";
const ELEVENLABS_UNAVAILABLE_MESSAGE =
  "ElevenLabs voice service unavailable.";
const ELEVENLABS_SAFE_REASONS = new Set([
  "quota exceeded",
  "paid plan required",
  "invalid key",
  "voice unavailable",
  "rate limit",
  "network error",
]);

function getAssistantModeGreeting() {
  const hour = new Date().getHours();
  return hour >= 5 && hour < 12
    ? "Good morning Jimmy, Heney is here."
    : "Hi Jimmy, Heney is here.";
}

function AssistantApp() {
  const { user, signOut } = useAuth();
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(true);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [assistantMode, setAssistantMode] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [serviceStatus, setServiceStatus] = useState(null);
  const [serviceIssue, setServiceIssue] = useState("online");
  const [elevenLabsVoice, setElevenLabsVoice] = useState({
    online: true,
    reason: "",
  });
  const [error, setError] = useState("");
  const [micPermission, setMicPermission] = useState("unknown");
  const [vadStatus, setVadStatus] = useState("not-loaded");
  const [voiceDebug, setVoiceDebug] = useState({
    listeningStarted: false,
    audioStarted: false,
    speechDetected: false,
    transcriptReceived: false,
    transcriptAutoSent: false,
    recognitionEnded: false,
    recognitionError: "",
    lastTranscript: "",
  });

  const recognitionRef = useRef(null);
  const vadRef = useRef(null);
  const scrollRef = useRef(null);
  const restartTimerRef = useRef(null);
  const turnGraceTimerRef = useRef(null);
  const fallbackTurnTimerRef = useRef(null);
  const pendingTranscriptRef = useRef("");
  const speechActiveRef = useRef(false);
  const vadEnabledRef = useRef(false);
  const vadLoadingRef = useRef(false);
  const speakingResolveRef = useRef(null);
  const recorderStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const completedAudioBlobsRef = useRef([]);
  const recordedAudioBlobRef = useRef(null);
  const recordingStopPromiseRef = useRef(null);
  const ttsAudioRef = useRef(null);
  const ttsAudioUrlRef = useRef("");
  const ttsAudioRejectRef = useRef(null);
  const speechAbortRef = useRef(0);
  const ttsStartedAtRef = useRef(0);

  const conversationRef = useRef(conversation);
  const messagesRef = useRef(messages);
  const assistantModeRef = useRef(assistantMode);
  const loadingRef = useRef(loading);
  const conversationLoadingRef = useRef(conversationLoading);
  const listeningRef = useRef(false);
  const speakingRef = useRef(false);
  const speakRepliesRef = useRef(speakReplies);
  const handleSendMessageRef = useRef(null);

  function serviceIssueFromStatus(nextStatus) {
    if (!nextStatus?.backend?.ok) return "backend";
    if (nextStatus.gemini?.configured && nextStatus.gemini?.ok === false) {
      return "gemini";
    }
    if (
      nextStatus.elevenLabs?.configured &&
      (nextStatus.elevenLabs?.tts?.ok === false ||
        nextStatus.elevenLabs?.stt?.ok === false)
    ) {
      return "elevenlabs";
    }
    return "online";
  }

  function serviceIssueLabel(issue = serviceIssue) {
    switch (issue) {
      case "gemini":
        return "Gemini quota issue";
      case "elevenlabs":
        return "ElevenLabs issue";
      case "backend":
        return "Backend issue";
      case "supabase":
        return "Supabase/auth issue";
      default:
        return "Online";
    }
  }

  function normalizeElevenLabsReason(errOrReason) {
    const raw =
      typeof errOrReason === "string"
        ? errOrReason
        : errOrReason?.safeReason || errOrReason?.data?.safeReason || "";
    const normalized = raw.toLowerCase().trim();

    if (ELEVENLABS_SAFE_REASONS.has(normalized)) return normalized;
    if (normalized.includes("quota") || normalized.includes("credit")) {
      return "quota exceeded";
    }
    if (normalized.includes("paid") || normalized.includes("subscription")) {
      return "paid plan required";
    }
    if (normalized.includes("invalid") || normalized.includes("key")) {
      return "invalid key";
    }
    if (normalized.includes("voice")) {
      return "voice unavailable";
    }
    if (normalized.includes("rate")) {
      return "rate limit";
    }
    return "network error";
  }

  function titleCaseReason(reason) {
    return reason.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function elevenLabsVoiceLabel() {
    return elevenLabsVoice.online
      ? "ElevenLabs Online"
      : `ElevenLabs Offline — ${titleCaseReason(elevenLabsVoice.reason)}`;
  }

  function setElevenLabsOnline() {
    setElevenLabsVoice({ online: true, reason: "" });
  }

  function markElevenLabsUnavailable(errOrReason) {
    const reason = normalizeElevenLabsReason(errOrReason);
    console.warn("[TTS] ElevenLabs unavailable", reason);
    if (reason === "quota exceeded") {
      console.warn("[TTS] quota exceeded");
    }

    speechAbortRef.current += 1;
    ttsAudioRejectRef.current?.(new Error("Speech interrupted."));
    ttsAudioRejectRef.current = null;
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.src = "";
      ttsAudioRef.current = null;
    }
    if (ttsAudioUrlRef.current) {
      URL.revokeObjectURL(ttsAudioUrlRef.current);
      ttsAudioUrlRef.current = "";
    }
    speakingResolveRef.current?.();
    speakingResolveRef.current = null;
    speakingRef.current = false;
    setSpeaking(false);
    setStatus(assistantModeRef.current ? "Listening" : "Idle");
    setServiceIssue("elevenlabs");
    setElevenLabsVoice({ online: false, reason });
    setError(`${ELEVENLABS_UNAVAILABLE_MESSAGE} ${reason}.`);
  }

  function isStatusPrompt(message) {
    const normalized = message.toLowerCase().replace(/[?.!,]/g, "").trim();
    return (
      normalized === "heney status" ||
      normalized === "are you working" ||
      normalized === "check your systems"
    );
  }

  function formatSystemStatus(nextStatus = serviceStatus, issue = serviceIssue) {
    if (!nextStatus) {
      return "I cannot reach my status monitor right now. Text chat and local skills may still work if the app is online.";
    }

    const lines = [
      `Overall: ${serviceIssueLabel(issue)}.`,
      `Backend: ${nextStatus.backend?.ok ? "online" : "issue"}.`,
      `Gemini: ${
        nextStatus.gemini?.configured
          ? nextStatus.gemini?.ok
            ? "available"
            : "quota or availability issue"
          : "not configured"
      }.`,
      `ElevenLabs: ${
        nextStatus.elevenLabs?.configured
          ? nextStatus.elevenLabs?.tts?.ok && nextStatus.elevenLabs?.stt?.ok
            ? "available"
            : "voice issue"
          : "not configured"
      }.`,
      `Supabase/auth: ${
        nextStatus.supabase?.configured === false ? "backend env not configured" : "configured"
      }.`,
    ];

    return lines.join(" ");
  }

  async function refreshServiceStatus({ quiet = true } = {}) {
    try {
      const nextStatus = await fetchServiceStatus();
      const nextIssue = serviceIssueFromStatus(nextStatus);
      setServiceStatus(nextStatus);
      setServiceIssue(nextIssue);
      if (nextStatus.elevenLabs?.configured && nextStatus.elevenLabs?.tts?.ok) {
        setElevenLabsVoice((current) =>
          current.online ? { online: true, reason: "" } : current
        );
      } else if (nextStatus.elevenLabs?.configured === false) {
        setElevenLabsVoice({ online: false, reason: "invalid key" });
      } else if (nextStatus.elevenLabs?.tts?.ok === false) {
        setElevenLabsVoice({
          online: false,
          reason: normalizeElevenLabsReason(nextStatus.elevenLabs?.tts?.safeReason),
        });
      }
      return { status: nextStatus, issue: nextIssue };
    } catch (err) {
      setServiceIssue("backend");
      if (!quiet) {
        setError("I cannot reach the backend status monitor right now.");
      }
      return { status: null, issue: "backend" };
    }
  }

  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let active = true;

    async function restoreConversation() {
      setConversationLoading(true);
      setError("");

      try {
        const restored = await loadMostRecentConversation(user.id);

        if (!active) return;

        setConversation(restored.conversation);
        setMessages(restored.messages);
        setStatus("Idle");
      } catch (err) {
        if (!active) return;
        setServiceIssue("supabase");
        setError(err.message || "Could not load your conversation.");
      } finally {
        if (active) {
          setConversationLoading(false);
        }
      }
    }

    restoreConversation();

    return () => {
      active = false;
    };
  }, [user.id]);

  useEffect(() => {
    assistantModeRef.current = assistantMode;
  }, [assistantMode]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    conversationLoadingRef.current = conversationLoading;
  }, [conversationLoading]);

  useEffect(() => {
    let active = true;

    async function pollStatus() {
      if (active) {
        await refreshServiceStatus({ quiet: true });
      }
    }

    pollStatus();
    const intervalId = window.setInterval(pollStatus, 60000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    speakRepliesRef.current = speakReplies;
  }, [speakReplies]);

  useEffect(() => {
    if (!navigator.permissions?.query) {
      setMicPermission("unknown");
      return;
    }

    let permissionStatus;
    let active = true;

    navigator.permissions
      .query({ name: "microphone" })
      .then((statusResult) => {
        if (!active) return;

        permissionStatus = statusResult;
        setMicPermission(permissionStatus.state);
        permissionStatus.onchange = () => {
          setMicPermission(permissionStatus.state);
        };
      })
      .catch(() => {
        if (active) {
          setMicPermission("unknown");
        }
      });

    return () => {
      active = false;
      if (permissionStatus) {
        permissionStatus.onchange = null;
      }
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  useEffect(() => {
    if (!speechSupported) return;

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onstart = () => {
      console.log("[voice] recognition.onstart");
      listeningRef.current = true;
      setListening(true);
      if (!speechActiveRef.current && !loadingRef.current && !speakingRef.current) {
        setStatus("Listening");
      }
      setVoiceDebug((prev) => ({
        ...prev,
        listeningStarted: true,
        recognitionEnded: false,
        recognitionError: "",
      }));
    };

    recognition.onaudiostart = () => {
      console.log("[voice] recognition.onaudiostart");
      setVoiceDebug((prev) => ({
        ...prev,
        audioStarted: true,
      }));
    };

    recognition.onspeechstart = () => {
      console.log("[voice] recognition.onspeechstart");
      handleSpeechStart();
      setVoiceDebug((prev) => ({
        ...prev,
        speechDetected: true,
      }));
    };

    recognition.onresult = (event) => {
      console.log("[voice] recognition.onresult", event);
      const transcript = Array.from(event.results || [])
        .slice(event.resultIndex || 0)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript?.trim() || "")
        .filter(Boolean)
        .join(" ")
        .trim();

      setVoiceDebug((prev) => ({
        ...prev,
        transcriptReceived: Boolean(transcript),
        lastTranscript: transcript || prev.lastTranscript,
      }));

      if (!transcript) {
        setError("I could not hear anything. Check your microphone permission.");
        setStatus("Idle");
        return;
      }

      setInput("");

      if (assistantModeRef.current) {
        appendPendingTranscript(transcript);

        if (!vadEnabledRef.current) {
          scheduleFallbackTurnCompletion();
        }
      } else {
        setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    };

    recognition.onerror = (event) => {
      console.log("[voice] recognition.onerror", event);
      setVoiceDebug((prev) => ({
        ...prev,
        recognitionError: event.error || "unknown",
      }));

      if (event.error !== "aborted") {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setMicPermission("denied");
          setError(
            "Microphone access is blocked. Allow microphone permission in your browser."
          );
        } else if (event.error === "no-speech" && !assistantModeRef.current) {
          setError("I could not hear anything. Check your microphone permission.");
        } else if (event.error !== "no-speech") {
          setError(`Microphone error: ${event.error}`);
        }
      }

      listeningRef.current = false;
      setListening(false);

      if (!assistantModeRef.current) {
        setStatus("Idle");
      }
    };

    recognition.onend = () => {
      console.log("[voice] recognition.onend");
      listeningRef.current = false;
      setListening(false);
      setVoiceDebug((prev) => ({
        ...prev,
        recognitionEnded: true,
      }));

      if (
        assistantModeRef.current &&
        !loadingRef.current &&
        !speakingRef.current
      ) {
        scheduleListening(vadEnabledRef.current ? 200 : 600);
      } else if (!loadingRef.current && !speakingRef.current) {
        setStatus("Idle");
      }
    };

    recognitionRef.current = recognition;

    return () => {
      clearTimeout(restartTimerRef.current);
      clearTimeout(turnGraceTimerRef.current);
      clearTimeout(fallbackTurnTimerRef.current);
      recognition.abort();
      vadRef.current?.destroy?.();
      releaseRecorderStream();
    };
  }, []);

  function appendPendingTranscript(transcript) {
    pendingTranscriptRef.current = pendingTranscriptRef.current
      ? `${pendingTranscriptRef.current} ${transcript}`.trim()
      : transcript.trim();
  }

  function preferredAudioMimeType() {
    if (typeof MediaRecorder === "undefined") return "";

    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];

    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  async function getRecorderStream() {
    if (recorderStreamRef.current?.active) {
      return recorderStreamRef.current;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    recorderStreamRef.current = stream;
    return stream;
  }

  async function startTurnRecording() {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }

    try {
      const stream = await getRecorderStream();
      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );

      audioChunksRef.current = [];
      recordedAudioBlobRef.current = null;
      recordingStopPromiseRef.current = new Promise((resolve) => {
        recorder.ondataavailable = (event) => {
          if (event.data?.size) {
            audioChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = () => {
          const type = recorder.mimeType || mimeType || "audio/webm";
          recordedAudioBlobRef.current = audioChunksRef.current.length
            ? new Blob(audioChunksRef.current, { type })
            : null;
          if (recordedAudioBlobRef.current?.size) {
            completedAudioBlobsRef.current.push(recordedAudioBlobRef.current);
          }
          resolve(recordedAudioBlobRef.current);
        };

        recorder.onerror = () => resolve(null);
      });

      mediaRecorderRef.current = recorder;
      recorder.start();
    } catch (err) {
      console.warn("ElevenLabs recorder failed to start; STT fallback may be used.", err);
    }
  }

  function stopTurnRecording() {
    const recorder = mediaRecorderRef.current;

    if (recorder?.state === "recording") {
      try {
        recorder.stop();
      } catch (err) {
        console.warn("ElevenLabs recorder failed to stop.", err);
      }
    }
  }

  async function getRecordedAudioBlob() {
    if (recordingStopPromiseRef.current) {
      await recordingStopPromiseRef.current.catch(() => null);
    }

    return recordedAudioBlobRef.current;
  }

  function releaseRecorderStream() {
    recorderStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    recorderStreamRef.current = null;
    mediaRecorderRef.current = null;
  }

  async function resolveVoiceTranscript() {
    const fallbackTranscript = pendingTranscriptRef.current.trim();
    await getRecordedAudioBlob();
    const audioBlobs = completedAudioBlobsRef.current.filter((blob) => blob?.size);
    const audioType = audioBlobs[0]?.type || "audio/webm";
    const audioBlob = audioBlobs.length
      ? new Blob(audioBlobs, { type: audioType })
      : null;
    pendingTranscriptRef.current = "";
    completedAudioBlobsRef.current = [];
    recordedAudioBlobRef.current = null;
    recordingStopPromiseRef.current = null;

    if (audioBlob?.size) {
      try {
        const transcript = await transcribeSpeech(audioBlob);
        if (transcript.trim()) {
          return transcript.trim();
        }
      } catch (err) {
        console.warn("ElevenLabs STT failed; using browser SpeechRecognition fallback.", err);
        if (err.errorType?.startsWith("elevenlabs")) {
          setServiceIssue("elevenlabs");
        }
      }
    }

    return fallbackTranscript;
  }

  async function submitCompletedVoiceTurn() {
    const transcript = await resolveVoiceTranscript();

    if (!transcript) {
      setStatus("Listening");
      return;
    }

    setVoiceDebug((prev) => ({
      ...prev,
      transcriptAutoSent: true,
    }));
    handleSendMessageRef.current?.(transcript, { voiceMode: true });
  }

  function scheduleTurnCompletion(delay = TURN_END_GRACE_MS) {
    clearTimeout(turnGraceTimerRef.current);
    setStatus("Waiting for you to finish");

    turnGraceTimerRef.current = setTimeout(() => {
      if (speechActiveRef.current || loadingRef.current || speakingRef.current) {
        return;
      }

      submitCompletedVoiceTurn();
    }, delay);
  }

  function scheduleFallbackTurnCompletion() {
    clearTimeout(fallbackTurnTimerRef.current);
    setStatus("Waiting for you to finish");

    fallbackTurnTimerRef.current = setTimeout(() => {
      const transcript = pendingTranscriptRef.current.trim();
      pendingTranscriptRef.current = "";

      if (!assistantModeRef.current || loadingRef.current || speakingRef.current) {
        return;
      }

      if (!transcript) {
        setStatus("Listening");
        return;
      }

      setVoiceDebug((prev) => ({
        ...prev,
        transcriptAutoSent: true,
      }));
      handleSendMessageRef.current?.(transcript, { voiceMode: true });
    }, FALLBACK_SILENCE_DELAY_MS);
  }

  function handleSpeechStart() {
    clearTimeout(turnGraceTimerRef.current);
    clearTimeout(fallbackTurnTimerRef.current);
    speechActiveRef.current = true;
    setStatus("Speaking detected");

    if (speakingRef.current) {
      if (Date.now() - ttsStartedAtRef.current < SELF_INTERRUPT_GUARD_MS) {
        speechActiveRef.current = false;
        setStatus("Speaking");
        return;
      }

      stopSpeaking();
      startTurnRecording();
      scheduleListening(50);
      return;
    }

    startTurnRecording();
  }

  function handleSpeechEnd() {
    speechActiveRef.current = false;

    if (!assistantModeRef.current || loadingRef.current || speakingRef.current) {
      return;
    }

    stopTurnRecording();
    scheduleTurnCompletion();
  }

  function scheduleListening(delay = 600) {
    clearTimeout(restartTimerRef.current);

    restartTimerRef.current = setTimeout(() => {
      if (
        assistantModeRef.current &&
        !loadingRef.current &&
        !speakingRef.current
      ) {
        startListening();
      }
    }, delay);
  }

  function startListening() {
    if (
      !speechSupported ||
      listeningRef.current ||
      (speakingRef.current && !assistantModeRef.current) ||
      loadingRef.current ||
      conversationLoadingRef.current
    ) {
      return;
    }

    setError("");
    setVoiceDebug((prev) => ({
      ...prev,
      listeningStarted: false,
      audioStarted: false,
      speechDetected: false,
      transcriptReceived: false,
      transcriptAutoSent: false,
      recognitionEnded: false,
      recognitionError: "",
    }));

    try {
      recognitionRef.current?.start();
    } catch (err) {
      console.log("[voice] recognition.start failed", err);
    }
  }

  function stopListening() {
    clearTimeout(restartTimerRef.current);
    recognitionRef.current?.stop();
    listeningRef.current = false;
    setListening(false);
  }

  async function ensureVad() {
    if (vadRef.current || vadLoadingRef.current || vadStatus === "failed") {
      return vadRef.current;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVadStatus("failed");
      return null;
    }

    vadLoadingRef.current = true;
    setVadStatus("loading");

    try {
      const { MicVAD } = await import("@ricky0123/vad-web");
      const vad = await MicVAD.new({
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        model: "v5",
        startOnLoad: false,
        getStream: () =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }),
        onSpeechStart: handleSpeechStart,
        onSpeechEnd: handleSpeechEnd,
        onVADMisfire: handleSpeechEnd,
      });

      vadRef.current = vad;
      vadEnabledRef.current = true;
      setVadStatus("loaded");
      return vad;
    } catch (err) {
      console.warn("VAD failed to load; using SpeechRecognition fallback.", err);
      vadEnabledRef.current = false;
      setVadStatus("failed");
      return null;
    } finally {
      vadLoadingRef.current = false;
    }
  }

  async function startVad() {
    const vad = await ensureVad();

    if (!vad || !assistantModeRef.current) {
      return false;
    }

    try {
      await vad.start();
      vadEnabledRef.current = true;
      setVadStatus("loaded");
      return true;
    } catch (err) {
      console.warn("VAD failed to start; using SpeechRecognition fallback.", err);
      vadEnabledRef.current = false;
      setVadStatus("failed");
      return false;
    }
  }

  function stopVad() {
    try {
      vadRef.current?.pause?.();
    } catch (err) {
      console.warn("VAD failed to pause.", err);
    }

    vadEnabledRef.current = false;
  }

  function stopSpeaking() {
    if (!speakingRef.current) return;

    speechAbortRef.current += 1;
    speakingRef.current = false;
    setSpeaking(false);
    setStatus("Listening");
    ttsAudioRejectRef.current?.(new Error("Speech interrupted."));
    ttsAudioRejectRef.current = null;
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.src = "";
      ttsAudioRef.current = null;
    }
    if (ttsAudioUrlRef.current) {
      URL.revokeObjectURL(ttsAudioUrlRef.current);
      ttsAudioUrlRef.current = "";
    }
    window.speechSynthesis?.cancel();
    speakingResolveRef.current?.();
    speakingResolveRef.current = null;
  }

  function splitSpeechChunks(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return [];

    const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
    const chunks = [];
    let current = "";

    for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
      const next = current ? `${current} ${sentence}` : sentence;

      if (next.length > 220 && current) {
        chunks.push(current);
        current = sentence;
      } else {
        current = next;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  function takeCompleteSpeechChunks(buffer, force = false) {
    const chunks = [];
    let remaining = buffer.replace(/\s+/g, " ").trimStart();
    const sentencePattern = /^(.+?[.!?])(\s+|$)/;

    while (true) {
      const match = remaining.match(sentencePattern);
      if (!match) break;

      chunks.push(match[1].trim());
      remaining = remaining.slice(match[0].length).trimStart();
    }

    if (force && remaining.trim()) {
      chunks.push(remaining.trim());
      remaining = "";
    }

    return { chunks, remaining };
  }

  function createStreamingSpeaker(waitFor = Promise.resolve()) {
    let buffer = "";
    let chain = Promise.resolve(waitFor).catch((err) => {
      console.warn("Bridge speech failed before streamed speech.", err);
    });
    const speechRunId = speechAbortRef.current;

    function enqueueChunk(chunk) {
      if (!chunk || speechRunId !== speechAbortRef.current) return;

      chain = chain.then(async () => {
        if (speechRunId !== speechAbortRef.current) return;
        await speak(chunk, { chunked: false, resumeListening: false });
      });
    }

    return {
      push(text) {
        buffer += text || "";
        const result = takeCompleteSpeechChunks(buffer);
        buffer = result.remaining;
        result.chunks.forEach(enqueueChunk);
      },
      async finish() {
        const result = takeCompleteSpeechChunks(buffer, true);
        buffer = result.remaining;
        result.chunks.forEach(enqueueChunk);
        await chain;
      },
    };
  }

  function playAudioBlob(audioBlob, speechRunId) {
    return new Promise((resolve, reject) => {
      if (speechRunId !== speechAbortRef.current) {
        reject(new Error("Speech interrupted."));
        return;
      }

      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.src = "";
        ttsAudioRef.current = null;
      }
      if (ttsAudioUrlRef.current) {
        URL.revokeObjectURL(ttsAudioUrlRef.current);
        ttsAudioUrlRef.current = "";
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      ttsAudioRef.current = audio;
      ttsAudioUrlRef.current = audioUrl;
      ttsAudioRejectRef.current = reject;

      const cleanup = () => {
        if (ttsAudioUrlRef.current === audioUrl) {
          URL.revokeObjectURL(audioUrl);
          ttsAudioUrlRef.current = "";
        }
        if (ttsAudioRef.current === audio) {
          ttsAudioRef.current = null;
        }
        if (ttsAudioRejectRef.current === reject) {
          ttsAudioRejectRef.current = null;
        }
      };

      audio.onended = () => {
        cleanup();
        console.log("[TTS] playback finished");
        resolve();
      };

      audio.onerror = () => {
        cleanup();
        reject(new Error("ElevenLabs audio playback failed."));
      };

      audio.play().catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  function speak(text, options = {}) {
    return new Promise(async (resolve) => {
      if (!speakRepliesRef.current) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        speakingResolveRef.current = null;
        speakingRef.current = false;
        setSpeaking(false);
        setStatus(assistantModeRef.current ? "Listening" : "Idle");
        resolve();

        if (assistantModeRef.current && options.resumeListening !== false) {
          scheduleListening(300);
        }
      };

      const speechRunId = speechAbortRef.current;
      speakingRef.current = true;
      setSpeaking(true);
      setStatus("Speaking");
      ttsStartedAtRef.current = Date.now();
      stopListening();
      window.speechSynthesis.cancel();
      speakingResolveRef.current = finish;

      try {
        const chunks = options.chunked === false ? [text] : splitSpeechChunks(text);

        for (const chunk of chunks) {
          if (settled || speechRunId !== speechAbortRef.current) return;
          console.log("[TTS] ElevenLabs request started");
          const audioBlob = await synthesizeSpeech(chunk);
          console.log("[TTS] ElevenLabs success");
          setElevenLabsOnline();
          if (settled || speechRunId !== speechAbortRef.current) return;
          await playAudioBlob(audioBlob, speechRunId);
        }

        finish();
        return;
      } catch (err) {
        if (settled) return;
        if (speechRunId !== speechAbortRef.current) return;
        markElevenLabsUnavailable(err);
        finish();
      }
    });
  }

  async function saveAssistantReply(activeConversation, reply) {
    const assistantMessage = await saveMessage(
      user.id,
      activeConversation.id,
      "assistant",
      reply
    );
    setMessages((prev) => [...prev, assistantMessage]);

    const updatedConversation = await updateConversation(activeConversation.id, {
      updated_at: new Date().toISOString(),
    });
    setConversation(updatedConversation);
    conversationRef.current = updatedConversation;
    return assistantMessage;
  }

  async function saveAndSpeakAssistantReply(activeConversation, reply) {
    await saveAssistantReply(activeConversation, reply);
    await speak(reply);
  }

  async function speakBridgePhrase() {
    if (!assistantModeRef.current || !speakRepliesRef.current) return;

    const phrase =
      BRIDGE_PHRASES[Math.floor(Math.random() * BRIDGE_PHRASES.length)];

    try {
      await speak(phrase, { chunked: false, resumeListening: false });
    } catch (err) {
      console.warn("Bridge speech failed.", err);
    }
  }

  async function handleSendMessage(text, options = {}) {
    const cleanText = text.trim();
    if (!cleanText || loadingRef.current || conversationLoading) return;
    const voiceMode = options.voiceMode === true;

    setError("");
    setInput("");
    setLoading(true);
    loadingRef.current = true;
    setStatus("Thinking");
    clearTimeout(turnGraceTimerRef.current);
    clearTimeout(fallbackTurnTimerRef.current);
    pendingTranscriptRef.current = "";
    completedAudioBlobsRef.current = [];
    speechActiveRef.current = false;
    setStatus("Thinking");
    stopListening();

    const history = messagesRef.current;

    try {
      let activeConversation = conversationRef.current;
      const shouldTitleFromPrompt = history.length === 0;

      if (!activeConversation) {
        activeConversation = await createConversation(
          user.id,
          generateConversationTitle(cleanText)
        );
        setConversation(activeConversation);
        conversationRef.current = activeConversation;
      } else if (
        shouldTitleFromPrompt &&
        activeConversation.title === "New conversation"
      ) {
        activeConversation = await updateConversation(activeConversation.id, {
          title: generateConversationTitle(cleanText),
        });
        setConversation(activeConversation);
        conversationRef.current = activeConversation;
      }

      const userMessage = await saveMessage(
        user.id,
        activeConversation.id,
        "user",
        cleanText
      );
      setMessages((prev) => [...prev, userMessage]);

      if (isStatusPrompt(cleanText)) {
        const result = await refreshServiceStatus({ quiet: false });
        const reply = formatSystemStatus(result.status, result.issue);
        await saveAndSpeakAssistantReply(activeConversation, reply);
        return;
      }

      const skillReply = await getLocalSkillReply({
        userId: user.id,
        message: cleanText,
        currentMessageId: userMessage.id,
      });

      if (skillReply) {
        const reply = skillReply;
        await saveAndSpeakAssistantReply(activeConversation, reply);
        return;
      }

      const bridgePromise = voiceMode
        ? speakBridgePhrase().finally(() => setStatus("Thinking"))
        : Promise.resolve();

      let memoryContext = "";

      try {
        await rememberFromMessage(user.id, cleanText, userMessage.id);
        const relevantMemories = await getRelevantMemories(user.id, cleanText);
        memoryContext = formatMemoriesForPrompt(relevantMemories);
      } catch (memoryError) {
        console.warn("Memory service error:", memoryError);
      }

      let reply = "";

      if (voiceMode) {
        const streamingSpeaker = createStreamingSpeaker(bridgePromise);

        try {
          reply = await streamChatMessage(
            cleanText,
            history,
            memoryContext,
            { voiceMode: true },
            (chunk) => {
              reply += chunk;
              streamingSpeaker.push(chunk);
            }
          );
          await streamingSpeaker.finish();
          await saveAssistantReply(activeConversation, reply);
        } catch (streamError) {
          console.warn("Gemini stream failed; using /api/chat fallback.", streamError);

          if (streamError.errorType === "gemini_quota") {
            reply = streamError.reply || streamError.message;
            setServiceIssue("gemini");
            await bridgePromise;
            await saveAndSpeakAssistantReply(activeConversation, reply);
            return;
          }

          if (!reply.trim()) {
            try {
              reply = await sendChatMessage(cleanText, history, memoryContext, {
                voiceMode: true,
              });
              await bridgePromise;
              await saveAndSpeakAssistantReply(activeConversation, reply);
            } catch (chatError) {
              if (chatError.errorType === "gemini_quota") {
                reply = chatError.reply || chatError.message;
                setServiceIssue("gemini");
                await bridgePromise;
                await saveAndSpeakAssistantReply(activeConversation, reply);
                return;
              }
              throw chatError;
            }
          } else {
            await streamingSpeaker.finish();
            await saveAssistantReply(activeConversation, reply);
          }
        }
      } else {
        try {
          reply = await streamChatMessage(cleanText, history, memoryContext);
        } catch (streamError) {
          console.warn("Gemini stream failed; using /api/chat fallback.", streamError);
          if (streamError.errorType === "gemini_quota") {
            reply = streamError.reply || streamError.message;
            setServiceIssue("gemini");
          } else {
            try {
              reply = await sendChatMessage(cleanText, history, memoryContext);
            } catch (chatError) {
              if (chatError.errorType === "gemini_quota") {
                reply = chatError.reply || chatError.message;
                setServiceIssue("gemini");
              } else {
                throw chatError;
              }
            }
          }
        }

        await saveAndSpeakAssistantReply(activeConversation, reply);
      }
    } catch (err) {
      if (err.errorType === "gemini_quota") {
        setServiceIssue("gemini");
      } else if (err.errorType?.startsWith("elevenlabs")) {
        setServiceIssue("elevenlabs");
      } else if (err.status >= 500 || err.name === "TypeError") {
        setServiceIssue("backend");
      }
      setError(err.message || "Something went wrong.");
      setStatus("Idle");
    } finally {
      setLoading(false);
      loadingRef.current = false;

      if (assistantModeRef.current && !speakingRef.current) {
        scheduleListening(700);
      }
    }
  }

  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage;
  });

  async function toggleAssistantMode() {
    const nextMode = !assistantMode;
    setAssistantMode(nextMode);
    assistantModeRef.current = nextMode;
    setError("");

    if (nextMode) {
      setSpeakReplies(true);
      speakRepliesRef.current = true;
      pendingTranscriptRef.current = "";
      speechActiveRef.current = false;
      await startVad();
      await speak(getAssistantModeGreeting());
      scheduleListening(100);
    } else {
      clearTimeout(restartTimerRef.current);
      clearTimeout(turnGraceTimerRef.current);
      clearTimeout(fallbackTurnTimerRef.current);
      pendingTranscriptRef.current = "";
      completedAudioBlobsRef.current = [];
      speechActiveRef.current = false;
      stopVad();
      releaseRecorderStream();
      stopListening();
      window.speechSynthesis?.cancel();
      speakingRef.current = false;
      setSpeaking(false);
      setStatus("Idle");
    }
  }

  function toggleListening() {
    if (!speechSupported) return;

    if (listening) {
      stopListening();
      setStatus("Idle");
    } else {
      startListening();
    }
  }

  function handleSend(e) {
    e?.preventDefault();
    handleSendMessage(input);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      handleSend(e);
    }
  }

  async function startNewChat() {
    if (loadingRef.current || conversationLoading) return;

    clearTimeout(restartTimerRef.current);
    clearTimeout(turnGraceTimerRef.current);
    clearTimeout(fallbackTurnTimerRef.current);
    pendingTranscriptRef.current = "";
    completedAudioBlobsRef.current = [];
    speechActiveRef.current = false;
    window.speechSynthesis?.cancel();
    releaseRecorderStream();
    stopListening();
    setSpeaking(false);
    setError("");
    setInput("");
    setConversationLoading(true);
    setStatus("Starting new chat...");

    try {
      const nextConversation = await createConversation(user.id);
      setConversation(nextConversation);
      conversationRef.current = nextConversation;
      setMessages([]);
      setStatus("Idle");
    } catch (err) {
      setError(err.message || "Could not start a new chat.");
      setStatus("Idle");
    } finally {
      setConversationLoading(false);
    }
  }

  const assistantState = speaking
    ? "speaking"
    : loading
    ? "thinking"
    : listening
    ? "listening"
    : assistantMode
    ? "online"
    : "idle";
  const voiceStateLabel = assistantMode
    ? status === "Speaking detected" ||
      status === "Waiting for you to finish" ||
      status === "Thinking" ||
      status === "Speaking" ||
      status === "Listening"
      ? status
      : "Listening"
    : "Turn on Assistant Mode to begin hands-free voice control.";

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__logo" aria-hidden="true">
            🤖
          </span>
          <div>
            <h1>{ASSISTANT_NAME}</h1>
            <p>Your always-listening AI assistant</p>
          </div>
        </div>

        <div className="app__controls">
          <span className="status">{status}</span>
          <button
            type="button"
            className={`voice-service-status ${
              elevenLabsVoice.online
                ? "voice-service-status--online"
                : "voice-service-status--offline"
            }`}
            onClick={() => refreshServiceStatus({ quiet: false })}
            title="Check ElevenLabs voice"
          >
            {elevenLabsVoiceLabel()}
          </button>
          <button
            type="button"
            className={`service-status service-status--${serviceIssue}`}
            onClick={() => refreshServiceStatus({ quiet: false })}
            title="Check Heney systems"
          >
            {serviceIssueLabel()}
          </button>

          <label className="toggle">
            <input
              type="checkbox"
              checked={assistantMode}
              onChange={toggleAssistantMode}
              disabled={!speechSupported}
            />
            <span>Assistant Mode</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={speakReplies}
              onChange={(e) => setSpeakReplies(e.target.checked)}
            />
            <span>Speak replies</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={showTranscript}
              onChange={(e) => setShowTranscript(e.target.checked)}
            />
            <span>Show transcript</span>
          </label>

          <button
            className="btn btn--ghost"
            onClick={startNewChat}
            disabled={loading || conversationLoading}
          >
            New Chat
          </button>

          <button className="btn btn--ghost" onClick={signOut}>
            Logout
          </button>
        </div>
      </header>

      <main className="voice-stage">
        <div className={`orb-shell orb-shell--${assistantState}`}>
          <div className="sound-waves" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>

          <button
            type="button"
            className="voice-orb"
            onClick={toggleAssistantMode}
            disabled={!speechSupported}
            aria-pressed={assistantMode}
            aria-label={
              assistantMode
                ? "Turn Assistant Mode off"
                : "Turn Assistant Mode on"
            }
          >
            <span className="voice-orb__core"></span>
          </button>
        </div>

        <div className="voice-status">
          <h2>{assistantMode ? "Assistant Mode On" : "Assistant Mode Off"}</h2>
          <p>{voiceStateLabel}</p>
        </div>

        {showVoiceDebug && (
          <div className="voice-debug" aria-live="polite">
            <div className="voice-debug__row">
              <span>Speech API</span>
              <strong>{speechSupportLabel}</strong>
            </div>
            <div className="voice-debug__row">
              <span>Microphone permission</span>
              <strong>{micPermission}</strong>
            </div>
            <div className="voice-debug__row">
              <span>VAD</span>
              <strong>{vadStatus}</strong>
            </div>
            <div className="voice-debug__grid">
              <span className={voiceDebug.listeningStarted ? "active" : ""}>
                Listening started
              </span>
              <span className={voiceDebug.audioStarted ? "active" : ""}>
                Audio started
              </span>
              <span className={voiceDebug.speechDetected ? "active" : ""}>
                Speech detected
              </span>
              <span className={voiceDebug.transcriptReceived ? "active" : ""}>
                Transcript received
              </span>
              <span className={voiceDebug.transcriptAutoSent ? "active" : ""}>
                Transcript auto-sent
              </span>
              <span className={voiceDebug.recognitionEnded ? "active" : ""}>
                Recognition ended
              </span>
            </div>
            <div className="voice-debug__row">
              <span>Recognition error</span>
              <strong>{voiceDebug.recognitionError || "none"}</strong>
            </div>
            <div className="voice-debug__row">
              <span>Last transcript</span>
              <strong>{voiceDebug.lastTranscript || "none"}</strong>
            </div>
          </div>
        )}
      </main>

      {!showTranscript && messages.length > 0 && (
        <div className="transcript-summary">
          <span>
            {messages.length} transcript item{messages.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => setShowTranscript(true)}
          >
            Show transcript
          </button>
        </div>
      )}

      <main
        className={`chat transcript ${showTranscript ? "" : "transcript--hidden"}`}
        ref={scrollRef}
        aria-hidden={!showTranscript}
      >
        {conversationLoading && (
          <div className="chat__empty">
            <p>Loading conversation...</p>
          </div>
        )}

        {messages.length === 0 && !loading && !conversationLoading && (
          <div className="chat__empty">
            <p>
              👋 Hi! Turn on Assistant Mode and talk to {ASSISTANT_NAME}, or
              type below.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`bubble bubble--${
              m.role === "user" ? "user" : "assistant"
            }`}
          >
            <div className="bubble__role">
              {m.role === "user" ? "You" : ASSISTANT_NAME}
            </div>
            <div className="bubble__text">{m.text}</div>
          </div>
        ))}

        {loading && (
          <div className="bubble bubble--assistant">
            <div className="bubble__role">{ASSISTANT_NAME}</div>
            <div className="typing">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </main>

      {error && <div className="app__error">{error}</div>}

      <form className="composer" onSubmit={handleSend}>
        <button
          type="button"
          className={`btn btn--mic ${listening ? "btn--mic-active" : ""}`}
          onClick={toggleListening}
          disabled={!speechSupported || assistantMode}
          title={
            assistantMode
              ? "Mic is controlled by Assistant Mode"
              : listening
              ? "Stop listening"
              : "Start voice input"
          }
        >
          {listening ? "⏹️" : "🎤"}
        </button>

        <textarea
          className="composer__input"
          placeholder={
            assistantMode
              ? `${ASSISTANT_NAME} is listening…`
              : listening
              ? "Listening…"
              : "Type a message…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />

        <button
          type="submit"
          className="btn btn--send"
          disabled={loading || !input.trim()}
        >
          {loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const { loading, user } = useAuth();

  if (loading) {
    return (
      <main className="auth-shell">
        <section className="auth-panel auth-panel--compact">
          <p className="auth-loading">Loading...</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return <AuthForm />;
  }

  return <AssistantApp />;
}
