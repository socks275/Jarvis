/**
 * J.A.R.V.I.S. Neural Voice Engine
 * Handles Speech Recognition (STT), Speech Synthesis (TTS),
 * Wake Word Detection ("Jarvis"), and OpenRouter AI Integration.
 */

// Default OpenRouter configuration
const DEFAULT_API_KEY = "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";
const DEFAULT_MODEL = "cohere/north-mini-code:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SYSTEM_PROMPT = "You are J.A.R.V.I.S., a concise, polite, highly intelligent AI assistant created by Tony Stark. Speak naturally without using asterisks (*), markdown formatting, thoughts, or meta summaries. Keep answers direct and butler-like.";

// Global state variables
let recognition = null;
let isSpeaking = false;
let isListening = false;
let selectedVoice = null;
let conversationHistory = [];

// Helper function to safely query DOM elements
const $ = (id) => document.getElementById(id);

/**
 * Safely encodes HTML special characters to prevent XSS injection.
 * @param {string} str - Raw text string.
 * @returns {string} Sanitized HTML string.
 */
function escapeHTML(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Sanitizes model responses for natural speech synthesis.
 * Strips markdown symbols, thinking chains, and fixes acronym pronunciation.
 * @param {string} text - Unfiltered text from AI or user.
 * @returns {string} Cleaned text ready for voice reading.
 */
function cleanSpeechText(text) {
    if (!text) return "";
    return text
        // Remove internal reasoning thoughts (<think>...</think>)
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        // Remove markdown formatting
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/`/g, "")
        .replace(/#/g, "")
        .replace(/_/g, "")
        // Fix acronym pronunciation so "J.A.R.V.I.S." is spoken as "Jarvis"
        .replace(/J\.A\.R\.V\.I\.S\./gi, "Jarvis")
        .replace(/J\.A\.R\.V\.I\.S/gi, "Jarvis")
        .trim();
}

/**
 * Renders messages to the communications terminal log.
 * @param {string} sender - 'YOU' or 'J.A.R.V.I.S.'
 * @param {string} text - Message body
 * @param {string} type - 'user' or 'jarvis'
 */
function addChatMessage(sender, text, type) {
    const chatStream = $("chat-stream");
    if (!chatStream) return;

    const messageDiv = document.createElement("div");
    messageDiv.className = type === "user"
        ? "bg-slate-950/80 border-l-2 border-slate-500 p-2.5 rounded-r-lg text-slate-300"
        : "bg-cyan-950/30 border-l-2 border-cyan-400 p-2.5 rounded-r-lg text-cyan-200";

    const senderClass = type === "user" ? "text-slate-400" : "text-cyan-400";
    messageDiv.innerHTML = `<span class="${senderClass} font-bold block mb-1">${escapeHTML(sender)}:</span><span>${escapeHTML(text).replace(/\n/g, "<br>")}</span>`;

    chatStream.appendChild(messageDiv);
    chatStream.scrollTop = chatStream.scrollHeight;
}

/**
 * Updates status text displays on the HUD.
 * @param {string} text - Status message
 */
function setHUDStatus(text) {
    const hudText = $("hud-status-text");
    if (hudText) {
        hudText.textContent = text;
    }
}

/**
 * Fast-path local heuristic engine for common user phrases (0ms latency).
 * @param {string} text - Raw user input query.
 * @returns {string|null} Instant response or null if cloud AI is needed.
 */
function getLocalResponse(text) {
    const query = text.toLowerCase().trim();

    // Acknowledgments & Greetings
    if (/^(ok|okay|thanks|thank you|got it|understood|cool|great|awesome|nice)\b/.test(query)) {
        const phrases = [
            "Happy to help, sir.",
            "Always at your service, sir.",
            "Glad to be of assistance, sir.",
            "Indeed, sir."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // Time query
    if (query.includes("time")) {
        const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `The current time is ${timeStr}, sir.`;
    }

    // Date query
    if (query.includes("date") || query.includes("day")) {
        const dateStr = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        return `Today is ${dateStr}, sir.`;
    }

    // Hello / Wake greeting
    if (/^(hi|hello|hey|greetings)\b/.test(query) || query === "jarvis") {
        return "Greetings, sir. How may I assist you today?";
    }

    return null; // Defer to Cloud AI
}

/**
 * Queries OpenRouter API for complex user commands.
 * @param {string} text - User query.
 * @returns {Promise<string>} AI text response.
 */
async function queryCloudAI(text) {
    const apiKey = localStorage.getItem("jarvis_api_key") || DEFAULT_API_KEY;
    const model = localStorage.getItem("jarvis_model") || DEFAULT_MODEL;

    if (!apiKey) {
        throw new Error("No API Key configured. Please enter your OpenRouter key.");
    }

    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversationHistory.slice(-8),
        { role: "user", content: text }
    ];

    const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json",
            "HTTP-Referer": window.location.href,
            "X-Title": "JARVIS Voice Assistant"
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            max_tokens: 180,
            temperature: 0.6
        })
    });

    let data = {};
    try {
        data = await response.json();
    } catch (e) {
        // Handle parsing errors gracefully
    }

    if (!response.ok) {
        throw new Error(data?.error?.message || `HTTP ${response.status} Error`);
    }

    let answer = data?.choices?.[0]?.message?.content;
    if (Array.isArray(answer)) {
        answer = answer.map(x => x?.text || "").join("");
    }

    answer = cleanSpeechText(answer);

    if (!answer) {
        throw new Error("Received empty response from AI engine.");
    }

    // Maintain recent conversation context
    conversationHistory.push({ role: "user", content: text }, { role: "assistant", content: answer });
    conversationHistory = conversationHistory.slice(-16);

    return answer;
}

/**
 * Main command router handling local fast-paths and cloud AI fallback.
 * @param {string} rawText - Speech transcript or typed input.
 */
async function processUserCommand(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return;

    addChatMessage("YOU", text, "user");
    setHUDStatus("J.A.R.V.I.S. is processing...");

    try {
        const localAnswer = getLocalResponse(text);
        const finalAnswer = localAnswer || await queryCloudAI(text);

        addChatMessage("J.A.R.V.I.S.", finalAnswer, "jarvis");
        speakText(finalAnswer);
    } catch (err) {
        const errText = "I could not complete that request, sir. " + err.message;
        addChatMessage("J.A.R.V.I.S.", errText, "jarvis");
        speakText(errText);
        setHUDStatus("Request failed.");
    }
}

/**
 * Discovers and populates US English voice synthesis options.
 */
function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    const availableVoices = speechSynthesis.getVoices();
    const voiceSelect = $("voice-select");

    if (voiceSelect) {
        voiceSelect.innerHTML = "";
    }

    const usVoices = availableVoices.filter(v => v.lang === "en-US" || v.lang.startsWith("en_US"));
    const otherVoices = availableVoices.filter(v => !(v.lang === "en-US" || v.lang.startsWith("en_US")));
    const sortedList = [...usVoices, ...otherVoices];

    sortedList.forEach((v, idx) => {
        if (voiceSelect) {
            const option = document.createElement("option");
            option.value = idx;
            option.textContent = `${v.name} (${v.lang})`;
            voiceSelect.appendChild(option);
        }

        // Default to US English Voice #7 or natural US voices
        if (idx === 6 || /Voice 7|David|Natural|Google US/i.test(v.name)) {
            selectedVoice = v;
            if (voiceSelect) voiceSelect.value = idx;
        }
    });

    if (!selectedVoice && sortedList.length > 0) {
        selectedVoice = sortedList[0];
    }
}

/**
 * Speaks text output via SpeechSynthesis API.
 * @param {string} text - Text to speak aloud.
 */
function speakText(text) {
    if (!("speechSynthesis" in window)) return;

    isSpeaking = true;
    speechSynthesis.cancel(); // Stop any active speech

    const cleanText = cleanSpeechText(text);
    const utterance = new SpeechSynthesisUtterance(cleanText);

    if (selectedVoice) {
        utterance.voice = selectedVoice;
    }

    const rateSlider = $("rate-slider");
    const pitchSlider = $("pitch-slider");
    utterance.rate = rateSlider ? parseFloat(rateSlider.value) : 1.0;
    utterance.pitch = pitchSlider ? parseFloat(pitchSlider.value) : 1.0;

    utterance.onstart = () => {
        animateVisualizer(true);
        setHUDStatus("J.A.R.V.I.S. is speaking...");
    };

    utterance.onend = () => {
        animateVisualizer(false);
        isSpeaking = false;
        setHUDStatus("Listening continuously for \"Jarvis\"...");
    };

    utterance.onerror = () => {
        animateVisualizer(false);
        isSpeaking = false;
        setHUDStatus("Listening continuously for \"Jarvis\"...");
    };

    speechSynthesis.speak(utterance);
}

/**
 * Animates the audio visualizer bars.
 * @param {boolean} active - Active state flag.
 */
function animateVisualizer(active) {
    const visualizer = $("visualizer-container");
    if (!visualizer) return;

    visualizer.querySelectorAll("span").forEach(bar => {
        bar.style.height = active ? (Math.random() * 24 + 6) + "px" : "6px";
    });
}

/**
 * Initializes continuous background recognition for "Jarvis" wake word.
 */
function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        const diagStt = $("diag-stt");
        if (diagStt) {
            diagStt.textContent = "UNSUPPORTED";
            diagStt.className = "text-rose-400 font-bold font-mono";
        }
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
        isListening = true;
        const micIcon = $("mic-icon");
        const micText = $("mic-text");
        if (micIcon) micIcon.className = "fa-solid fa-microphone-lines text-3xl md:text-4xl text-emerald-400 animate-pulse";
        if (micText) micText.textContent = "LISTENING...";
    };

    recognition.onresult = (event) => {
        if (isSpeaking) return; // Prevent listening to own voice output

        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
        }

        const rawLower = transcript.toLowerCase();
        // Normalize transcripts to capture "jarvis" regardless of periods
        const normalized = rawLower.replace(/j\.a\.r\.v\.i\.s\./g, "jarvis").replace(/j\.a\.r\.v\.i\.s/g, "jarvis");

        setHUDStatus(`"${transcript.trim()}"`);

        // Check for wake word trigger
        if (normalized.includes("jarvis") || normalized.includes("jervis")) {
            if (event.results[event.results.length - 1].isFinal) {
                let commandQuery = normalized
                    .replace(/^.*?(jarvis|jervis)/i, "")
                    .replace(/^[,\s]+/, "")
                    .trim();

                if (!commandQuery) {
                    commandQuery = "jarvis"; // Trigger butler greeting
                }

                processUserCommand(commandQuery);
            }
        }
    };

    recognition.onerror = (event) => {
        if (event.error !== "no-speech") {
            setHUDStatus("Speech error: " + event.error);
        }
    };

    // Auto-restart loop for continuous background listening
    recognition.onend = () => {
        isListening = false;
        setTimeout(() => {
            try {
                recognition.start();
            } catch (e) {
                // Ignore re-start exceptions if already running
            }
        }, 300);
    };

    try {
        recognition.start();
    } catch (e) {
        // Handle initial start exceptions
    }
}

/**
 * Binds UI buttons, sliders, and form submission events.
 */
function bindEventListeners() {
    const micBtn = $("mic-main-btn");
    if (micBtn) {
        micBtn.onclick = () => {
            if (!recognition) {
                initSpeechRecognition();
            } else {
                try {
                    speechSynthesis.cancel();
                    recognition.start();
                } catch (e) {
                    // Recognition already active
                }
            }
        };
    }

    const chatForm = $("chat-form");
    if (chatForm) {
        chatForm.onsubmit = (e) => {
            e.preventDefault();
            const input = $("user-input");
            if (input && input.value) {
                processUserCommand(input.value);
                input.value = "";
            }
        };
    }

    const testVoiceBtn = $("btn-test-voice");
    if (testVoiceBtn) {
        testVoiceBtn.onclick = () => speakText("Voice profile operational, sir. Wake word detection active.");
    }

    const clearChatBtn = $("btn-clear-chat");
    if (clearChatBtn) {
        clearChatBtn.onclick = () => {
            conversationHistory = [];
            const chatStream = $("chat-stream");
            if (chatStream) {
                chatStream.innerHTML = '<div class="bg-cyan-950/30 border-l-2 border-cyan-400 p-2.5 rounded-r-lg"><span class="text-cyan-400 font-bold block mb-1">J.A.R.V.I.S.:</span><span class="text-slate-200">Terminal log cleared, sir.</span></div>';
            }
        };
    }

    const voiceSelect = $("voice-select");
    if (voiceSelect) {
        voiceSelect.onchange = () => {
            const availableVoices = speechSynthesis.getVoices();
            selectedVoice = availableVoices[parseInt(voiceSelect.value)] || null;
        };
    }

    const rateSlider = $("rate-slider");
    if (rateSlider) {
        rateSlider.oninput = (e) => {
            const rateVal = $("rate-val");
            if (rateVal) rateVal.textContent = parseFloat(e.target.value).toFixed(1) + "x";
        };
    }

    const pitchSlider = $("pitch-slider");
    if (pitchSlider) {
        pitchSlider.oninput = (e) => {
            const pitchVal = $("pitch-val");
            if (pitchVal) pitchVal.textContent = parseFloat(e.target.value).toFixed(1);
        };
    }

    // Sample command quick buttons
    document.querySelectorAll(".sample-cmd").forEach(btn => {
        btn.onclick = () => {
            const cmd = btn.textContent.trim().replace(/^"|"$/g, "").replace(/^jarvis\s*/i, "");
            processUserCommand(cmd);
        };
    });
}

// Boot engine on window load
window.addEventListener("load", () => {
    bindEventListeners();
    initSpeechRecognition();
    loadVoices();

    if ("speechSynthesis" in window) {
        speechSynthesis.onvoiceschanged = loadVoices;
    }

    const diagModel = $("diag-model");
    if (diagModel) {
        diagModel.textContent = localStorage.getItem("jarvis_model") || DEFAULT_MODEL;
    }
});