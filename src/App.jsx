import { useEffect, useRef, useState } from "react";
import { AuthForm } from "./auth/AuthForm.jsx";
import { useAuth } from "./auth/AuthProvider.jsx";
import { sendChatMessage, synthesizeSpeech, transcribeSpeech } from "./lib/api.js";
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
const ttsSupported =
  typeof window !== "undefined" && "speechSynthesis" in window;
const showVoiceDebug = import.meta.env.VITE_SHOW_VOICE_DEBUG === "true";

const TURN_END_GRACE_MS = 1000;
const FALLBACK_SILENCE_DELAY_MS = 2200;
const ASSISTANT_NAME = "Heney";
const PREFERRED_VOICE_HINTS = [
  "natural",
  "online",
  "jenny",
  "aria",
  "zira",
  "sonia",
  "google uk english female",
  "microsoft",
  "female",
  "samantha",
  "natasha",
  "susan",
  "victoria",
  "karen",
];
const SOOTHING_VOICE_HINTS = ["female", "natural", "online", "neural"];

function findPreferredVoice(voices) {
  return (
    voices
      .map((voice) => {
        const name = voice.name.toLowerCase();
        const lang = (voice.lang || "").toLowerCase();
        const priorityMatch = PREFERRED_VOICE_HINTS.findIndex((hint) =>
          name.includes(hint)
        );
        const priorityScore =
          priorityMatch >= 0 ? (PREFERRED_VOICE_HINTS.length - priorityMatch) * 10 : 0;
        const soothingScore = SOOTHING_VOICE_HINTS.reduce(
          (score, hint) => score + (name.includes(hint) ? 6 : 0),
          0
        );
        const englishScore = lang.startsWith("en") ? 8 : 0;
        const defaultScore = voice.default ? 2 : 0;

        return {
          voice,
          score: priorityScore + soothingScore + englishScore + defaultScore,
        };
      })
      .sort((a, b) => b.score - a.score)[0]?.voice ||
    voices.find((voice) => voice.default) ||
    voices[0] ||
    null
  );
}

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
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState("");
  const [status, setStatus] = useState("Idle");
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

  const conversationRef = useRef(conversation);
  const messagesRef = useRef(messages);
  const assistantModeRef = useRef(assistantMode);
  const loadingRef = useRef(loading);
  const conversationLoadingRef = useRef(conversationLoading);
  const listeningRef = useRef(false);
  const speakingRef = useRef(false);
  const speakRepliesRef = useRef(speakReplies);
  const voicesRef = useRef(voices);
  const selectedVoiceURIRef = useRef(selectedVoiceURI);
  const handleSendMessageRef = useRef(null);

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
    speakRepliesRef.current = speakReplies;
  }, [speakReplies]);

  useEffect(() => {
    voicesRef.current = voices;
  }, [voices]);

  useEffect(() => {
    selectedVoiceURIRef.current = selectedVoiceURI;
  }, [selectedVoiceURI]);

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
    if (!ttsSupported) return;

    function loadVoices() {
      const availableVoices = window.speechSynthesis.getVoices();
      setVoices(availableVoices);

      setSelectedVoiceURI((currentVoiceURI) => {
        if (
          currentVoiceURI &&
          availableVoices.some((voice) => voice.voiceURI === currentVoiceURI)
        ) {
          return currentVoiceURI;
        }

        return findPreferredVoice(availableVoices)?.voiceURI || "";
      });
    }

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);

    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
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

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    handleSendMessageRef.current?.(transcript);
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
      handleSendMessageRef.current?.(transcript);
    }, FALLBACK_SILENCE_DELAY_MS);
  }

  function handleSpeechStart() {
    clearTimeout(turnGraceTimerRef.current);
    clearTimeout(fallbackTurnTimerRef.current);
    speechActiveRef.current = true;
    setStatus("Speaking detected");
    startTurnRecording();

    if (speakingRef.current) {
      stopSpeaking();
      scheduleListening(50);
    }
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

    speakingRef.current = false;
    setSpeaking(false);
    setStatus("Listening");
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

  function speak(text) {
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

        if (assistantModeRef.current) {
          scheduleListening(300);
        }
      };

      speakingRef.current = true;
      setSpeaking(true);
      setStatus("Speaking");
      stopListening();
      window.speechSynthesis.cancel();
      speakingResolveRef.current = finish;

      const playBrowserSpeech = () => {
        if (!ttsSupported) {
          finish();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        const selectedVoice =
          voicesRef.current.find(
            (voice) => voice.voiceURI === selectedVoiceURIRef.current
          ) || findPreferredVoice(voicesRef.current);

        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        utterance.lang = "en-US";
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.volume = 1;

        utterance.onend = () => {
          finish();
        };

        utterance.onerror = () => {
          finish();
        };

        window.speechSynthesis.speak(utterance);
      };

      try {
        const audioBlob = await synthesizeSpeech(text);
        if (settled) return;

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        ttsAudioRef.current = audio;
        ttsAudioUrlRef.current = audioUrl;

        audio.onended = () => {
          if (ttsAudioUrlRef.current) {
            URL.revokeObjectURL(ttsAudioUrlRef.current);
            ttsAudioUrlRef.current = "";
          }
          ttsAudioRef.current = null;
          finish();
        };

        audio.onerror = () => {
          if (ttsAudioUrlRef.current) {
            URL.revokeObjectURL(ttsAudioUrlRef.current);
            ttsAudioUrlRef.current = "";
          }
          ttsAudioRef.current = null;
          console.warn("ElevenLabs audio playback failed; using browser speech fallback.");
          playBrowserSpeech();
        };

        await audio.play();
        return;
      } catch (err) {
        if (settled) return;
        console.warn("ElevenLabs TTS failed; using browser speech fallback.", err);
      }

      playBrowserSpeech();
    });
  }

  async function saveAndSpeakAssistantReply(activeConversation, reply) {
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

    await speak(reply);
  }

  async function handleSendMessage(text) {
    const cleanText = text.trim();
    if (!cleanText || loadingRef.current || conversationLoading) return;

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

      let memoryContext = "";

      try {
        await rememberFromMessage(user.id, cleanText, userMessage.id);
        const relevantMemories = await getRelevantMemories(user.id, cleanText);
        memoryContext = formatMemoriesForPrompt(relevantMemories);
      } catch (memoryError) {
        console.warn("Memory service error:", memoryError);
      }

      const reply = await sendChatMessage(cleanText, history, memoryContext);
      await saveAndSpeakAssistantReply(activeConversation, reply);
    } catch (err) {
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

          <label className="toggle">
            <input
              type="checkbox"
              checked={assistantMode}
              onChange={toggleAssistantMode}
              disabled={!speechSupported}
            />
            <span>Assistant Mode</span>
          </label>

          {ttsSupported && (
            <label className="toggle">
              <input
                type="checkbox"
                checked={speakReplies}
                onChange={(e) => setSpeakReplies(e.target.checked)}
              />
              <span>Speak replies</span>
            </label>
          )}

          {ttsSupported && voices.length > 0 && (
            <label className="select-field">
              <span>Voice</span>
              <select
                value={selectedVoiceURI}
                onChange={(e) => setSelectedVoiceURI(e.target.value)}
              >
                {voices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name}
                  </option>
                ))}
              </select>
            </label>
          )}

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
