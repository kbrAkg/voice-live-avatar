const runtimeConfig = window.__RUNTIME_CONFIG__ || {};
const SpeechSDK = window.SpeechSDK;
import { VoiceLiveSession } from './voice-live.js';

const elements = {
  mode: document.getElementById('mode'),
  language: document.getElementById('language'),
  voiceApi: document.getElementById('voiceApi'),
  voice: document.getElementById('voice'),
  question: document.getElementById('question'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  listenButton: document.getElementById('listenButton'),
  askButton: document.getElementById('askButton'),
  micButton: document.getElementById('micButton'),
  micStatus: document.getElementById('micStatus'),
  questionDisplay: document.getElementById('question-display'),
  avatarVideo: document.getElementById('avatarVideo'),
  avatarAudio: document.getElementById('avatarAudio'),
  stageHint: document.getElementById('stageHint'),
  lastAnswer: document.getElementById('lastAnswer'),
  statusLog: document.getElementById('statusLog')
};

let backendConfig = null;
let voiceCatalog = [
  { locale: 'tr-TR', shortName: 'tr-TR-Elif:MAI-Voice-2', label: 'TR - Elif (MAI-Voice-2)' },
  { locale: 'tr-TR', shortName: 'tr-TR-Aydin:MAI-Voice-2', label: 'TR - Aydın (MAI-Voice-2)' },
  { locale: 'en-US', shortName: 'en-US-Harper:MAI-Voice-2', label: 'EN - Harper (MAI-Voice-2)' },
  { locale: 'en-US', shortName: 'en-US-Ethan:MAI-Voice-2', label: 'EN - Ethan (MAI-Voice-2)' },
  { locale: 'tr-TR', shortName: 'tr-TR-EmelNeural', label: 'TR - Emel Neural' },
  { locale: 'tr-TR', shortName: 'tr-TR-AhmetNeural', label: 'TR - Ahmet Neural' },
  { locale: 'en-US', shortName: 'en-US-AvaMultilingualNeural', label: 'EN - Ava Multilingual' },
  { locale: 'en-US', shortName: 'en-US-AndrewNeural', label: 'EN - Andrew Neural' }
];
let avatarCatalog = [
  { id: 'mentor', label: 'Mentor', character: 'lisa', style: 'casual-sitting' },
  { id: 'facilitator', label: 'Facilitator', character: 'lisa', style: 'graceful-sitting' },
  { id: 'coach', label: 'Coach', character: 'lisa', style: 'technical-sitting' }
];
let sessionState = {
  started: false,
  speechToken: null,
  tokenExpiryTime: null,
  speechConfig: null,
  recognizer: null,
  synthesizer: null,
  speakerDestination: null,
  avatarSynthesizer: null,
  peerConnection: null
};

let conversationActive = false;
let currentTurnAbortController = null;
let currentTurnId = 0;
let voiceLiveSession = null;

const modeLabelMap = {
  voiceOnly: 'Voice-Only',
  videoAvatar: 'Video Avatar'
};

function appendLog(line) {
  const timestamp = new Date().toLocaleTimeString();
  elements.statusLog.innerText += `[${timestamp}] ${line}\n`;
  elements.statusLog.scrollTop = elements.statusLog.scrollHeight;
}

function setAnswer(text) {
  elements.lastAnswer.textContent = text || '';
  if (text) {
    elements.lastAnswer.hidden = false;
  }
}

function setMicState(state) {
  // state: 'idle' | 'initializing' | 'listening' | 'processing' | 'speaking'
  const btn = elements.micButton;
  const statusEl = elements.micStatus;
  if (!btn) return;

  btn.classList.remove('listening', 'speaking', 'loading');

  const states = {
    idle:         { label: 'Konuşmak için bas', cls: '' },
    initializing: { label: 'Bağlanıyor...', cls: 'loading' },
    listening:    { label: '🎤 Dinleniyor...', cls: 'listening' },
    processing:   { label: 'Düşünüyor...', cls: 'loading' },
    speaking:     { label: '🔊 Cevap veriliyor...', cls: 'speaking' }
  };

  const s = states[state] || states.idle;
  if (s.cls) btn.classList.add(s.cls);
  if (statusEl) statusEl.textContent = s.label;
}

function showQuestion(text) {
  if (!elements.questionDisplay) return;
  elements.questionDisplay.textContent = text;
  elements.questionDisplay.hidden = !text;
}

function getBackendBaseUrl() {
  return runtimeConfig.backendBaseUrl || 'http://localhost:8081';
}

function getMcpBaseUrl() {
  return backendConfig?.rag?.endpoint || runtimeConfig.mcpBaseUrl || 'http://localhost:8082';
}

function clearSelect(selectElement) {
  while (selectElement.firstChild) {
    selectElement.removeChild(selectElement.firstChild);
  }
}

function setSelectOptions(selectElement, options, valueKey, labelKey, preferredValue = '') {
  clearSelect(selectElement);

  options.forEach((optionData) => {
    const option = document.createElement('option');
    option.value = optionData[valueKey];
    option.textContent = optionData[labelKey] || optionData[valueKey];
    selectElement.appendChild(option);
  });

  if (!options.length) {
    return;
  }

  const hasPreferred = preferredValue && options.some((option) => option[valueKey] === preferredValue);
  selectElement.value = hasPreferred ? preferredValue : options[0][valueKey];
}

function normalizeVoiceItem(voice) {
  return {
    locale: voice.locale || voice.language || 'tr-TR',
    shortName: voice.shortName || voice.name || voice.id || '',
    label: voice.label || voice.displayName || voice.shortName || voice.name || ''
  };
}

function normalizeAvatarItem(avatar) {
  // `character` must be a valid Azure prebuilt avatar (e.g. lisa, harry, jeff, lori, max, meg).
  // The catalog `id`/`label` is only a display alias, so fall back to a supported character.
  const character = avatar.character || avatar.avatarCharacter || 'lisa';
  return {
    id: avatar.id || avatar.avatarId || avatar.name || '',
    label: avatar.label || avatar.displayName || avatar.id || avatar.name || '',
    character,
    style: avatar.style || 'casual-sitting'
  };
}

function updateVoiceOptionsForLanguage(language, preferredVoice = '') {
  const languagePrefix = String(language || '').slice(0, 2).toLowerCase();
  const matchingVoices = voiceCatalog.filter((voice) => String(voice.locale || '').toLowerCase().startsWith(languagePrefix));
  const fallbackVoices = matchingVoices.length ? matchingVoices : voiceCatalog;
  setSelectOptions(elements.voice, fallbackVoices, 'shortName', 'label', preferredVoice);
}

function applyLiveSpeechSettings() {
  if (!sessionState.speechConfig) {
    return;
  }

  sessionState.speechConfig.speechRecognitionLanguage = elements.language.value;
  sessionState.speechConfig.speechSynthesisLanguage = elements.language.value;
  sessionState.speechConfig.speechSynthesisVoiceName = elements.voice.value;
}

function setupModes() {
  const enabledModes = runtimeConfig.enabledModes || {
    voiceOnly: true,
    videoAvatar: true
  };

  Object.entries(enabledModes)
    .filter(([, enabled]) => enabled)
    .forEach(([value]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = modeLabelMap[value] || value;
      elements.mode.appendChild(option);
    });

  // Default to the video avatar experience when it is enabled; otherwise fall
  // back to voice-only.
  if (enabledModes.videoAvatar) {
    elements.mode.value = 'videoAvatar';
  } else if (!elements.mode.value) {
    elements.mode.value = 'voiceOnly';
  }
}

async function loadBackendConfig() {
  const baseUrl = getBackendBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/api/config`);
    backendConfig = await response.json();
    const configVoices = backendConfig?.speech?.voiceCatalog;
    const configAvatars = backendConfig?.avatar?.catalog;

    if (Array.isArray(configVoices) && configVoices.length) {
      voiceCatalog = configVoices.map(normalizeVoiceItem).filter((voice) => voice.shortName);
    }

    if (Array.isArray(configAvatars) && configAvatars.length) {
      avatarCatalog = configAvatars.map(normalizeAvatarItem).filter((avatar) => avatar.id);
    }

    updateVoiceOptionsForLanguage(elements.language.value, backendConfig.defaultVoice || '');

    appendLog(`Profile: ${backendConfig.assistantDomain}/${backendConfig.assistantProfile}`);
    appendLog(`Default language: ${backendConfig.defaultLanguage}`);
    appendLog(`RAG endpoint: ${backendConfig.rag.endpoint}`);
    appendLog(`Voice catalog loaded: ${voiceCatalog.length}`);
    appendLog(`Avatar catalog loaded: ${avatarCatalog.length}`);
  } catch (error) {
    appendLog(`Backend config failed: ${error.message}`);
    updateVoiceOptionsForLanguage(elements.language.value);
  }
}

async function requestSpeechToken() {
  const baseUrl = getBackendBaseUrl();
  const response = await fetch(`${baseUrl}/api/speech/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    let details = '';
    try {
      const payload = await response.json();
      details = payload?.message ? `: ${payload.message}` : '';
    } catch {
      details = '';
    }
    throw new Error(`Speech token request failed with ${response.status}${details}`);
  }

  return response.json();
}

async function requestAvatarRelayToken() {
  const baseUrl = getBackendBaseUrl();
  const response = await fetch(`${baseUrl}/api/avatar/relay-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    let details = '';
    try {
      const payload = await response.json();
      details = payload?.message ? `: ${payload.message}` : '';
    } catch {
      details = '';
    }
    throw new Error(`Avatar relay token request failed with ${response.status}${details}`);
  }

  return response.json();
}

async function requestAnswer(question, language, signal) {
  const ragEndpoint = getMcpBaseUrl();
  const answerUrl = `${ragEndpoint.replace(/\/$/, '')}/mcp/tools/answer_question`;
  const response = await fetch(answerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    signal,
    body: JSON.stringify({
      question,
      language
    })
  });

  if (!response.ok) {
    throw new Error(`RAG request failed with ${response.status}`);
  }

  return response.json();
}

function stopRecognizer() {
  if (sessionState.recognizer) {
    sessionState.recognizer.close();
    sessionState.recognizer = null;
  }
}

function closeSynthesizers() {
  if (sessionState.avatarSynthesizer) {
    sessionState.avatarSynthesizer.close();
    sessionState.avatarSynthesizer = null;
  }

  if (sessionState.synthesizer) {
    sessionState.synthesizer.close();
    sessionState.synthesizer = null;
  }

  if (sessionState.speakerDestination) {
    try {
      if (typeof sessionState.speakerDestination.pause === 'function') {
        sessionState.speakerDestination.pause();
      }
      if (typeof sessionState.speakerDestination.close === 'function') {
        sessionState.speakerDestination.close();
      }
    } catch {
      // Ignore destination teardown race conditions.
    }
    sessionState.speakerDestination = null;
  }
}

function stopAvatarConnection() {
  if (sessionState.peerConnection) {
    sessionState.peerConnection.getSenders().forEach((sender) => sender.track?.stop());
    sessionState.peerConnection.getReceivers().forEach((receiver) => receiver.track?.stop());
    sessionState.peerConnection.close();
    sessionState.peerConnection = null;
  }

  elements.avatarVideo.srcObject = null;
  elements.avatarAudio.srcObject = null;
}

function destroySession() {
  stopRecognizer();
  closeSynthesizers();
  stopAvatarConnection();

  sessionState = {
    started: false,
    speechToken: null,
    tokenExpiryTime: null,
    speechConfig: null,
    recognizer: null,
    synthesizer: null,
    speakerDestination: null,
    avatarSynthesizer: null,
    peerConnection: null
  };

  elements.stageHint.hidden = false;
}

function createSpeechConfig(tokenPayload) {
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(tokenPayload.token, tokenPayload.region);
  speechConfig.speechRecognitionLanguage = elements.language.value;
  speechConfig.speechSynthesisLanguage = elements.language.value;
  speechConfig.speechSynthesisVoiceName = elements.voice.value;
  return speechConfig;
}

function buildIceServers(relayPayload) {
  if (Array.isArray(relayPayload.iceServers)) {
    return relayPayload.iceServers;
  }

  if (Array.isArray(relayPayload.IceServers)) {
    return relayPayload.IceServers;
  }

  const urls = relayPayload.Urls || relayPayload.urls;
  const username = relayPayload.Username || relayPayload.username;
  const credential = relayPayload.Password || relayPayload.password || relayPayload.credential;

  if (!urls || !username || !credential) {
    return [];
  }

  return [{
    urls,
    username,
    credential
  }];
}

async function startAvatarSession(speechConfig) {
  const relayPayload = await requestAvatarRelayToken();
  const iceServers = buildIceServers(relayPayload);

  if (!iceServers.length) {
    throw new Error('Avatar relay token did not include iceServers.');
  }

  const peerConnection = new RTCPeerConnection({ iceServers });
  sessionState.peerConnection = peerConnection;

  peerConnection.ontrack = (event) => {
    const stream = event.streams?.[0] || new MediaStream([event.track]);

    if (event.track.kind === 'video') {
      elements.avatarVideo.srcObject = stream;
      elements.avatarVideo.muted = true; // allow autoplay; audio comes via the audio element
      // Hide the "ready" hint only once the first video frame is actually rendering.
      elements.avatarVideo.addEventListener('playing', () => {
        elements.stageHint.hidden = true;
      }, { once: true });
      elements.avatarVideo.play().catch((err) => appendLog(`Video autoplay blocked: ${err.message}`));
      elements.stageHint.hidden = true;
      appendLog('Avatar video track connected.');
    }

    if (event.track.kind === 'audio') {
      elements.avatarAudio.srcObject = stream;
      elements.avatarAudio.play().catch((err) => appendLog(`Audio autoplay blocked: ${err.message}`));
      appendLog('Avatar audio track connected.');
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    appendLog(`ICE state: ${peerConnection.iceConnectionState}`);
  };
  peerConnection.onconnectionstatechange = () => {
    appendLog(`PeerConnection state: ${peerConnection.connectionState}`);
  };

  // Avatar streams are receive-only; add transceivers so ontrack reliably fires.
  peerConnection.addTransceiver('video', { direction: 'recvonly' });
  peerConnection.addTransceiver('audio', { direction: 'recvonly' });

  const defaultAvatarId = backendConfig?.defaultAvatar || '';
  const selectedAvatar = avatarCatalog.find((avatar) => avatar.id === defaultAvatarId) || avatarCatalog[0];
  const avatarCharacter = selectedAvatar?.character || 'lisa';
  const avatarStyle = selectedAvatar?.style || 'casual-sitting';
  appendLog(`Avatar character: ${avatarCharacter} / style: ${avatarStyle}`);

  const avatarConfig = new SpeechSDK.AvatarConfig(avatarCharacter, avatarStyle);
  const avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);

  avatarSynthesizer.avatarEventReceived = (_s, e) => {
    appendLog(`Avatar event: ${e.description || e.type || 'unknown'}`);
  };

  const result = await avatarSynthesizer.startAvatarAsync(peerConnection);
  if (result?.reason === SpeechSDK.ResultReason.Canceled) {
    const details = SpeechSDK.CancellationDetails.fromResult(result);
    throw new Error(`Avatar start canceled: ${details.errorDetails || details.reason}`);
  }

  sessionState.avatarSynthesizer = avatarSynthesizer;
  sessionState.synthesizer = avatarSynthesizer;
}

function createRecognizer(speechConfig) {
  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  return new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
}

function createVoiceOnlySynthesizer(speechConfig) {
  const speakerDestination = new SpeechSDK.SpeakerAudioDestination();
  const audioConfig = SpeechSDK.AudioConfig.fromSpeakerOutput(speakerDestination);
  const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, audioConfig);

  sessionState.speakerDestination = speakerDestination;
  sessionState.synthesizer = synthesizer;
}

function recognizeOnceAsync(recognizer) {
  return new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(
      (result) => {
        if (result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
          resolve(result.text || '');
          return;
        }

        const reasonMap = {
          0: 'NoMatch (no speech detected)',
          1: 'Canceled',
          2: 'SynthesizingAudioCompleted',
          3: 'SynthesizingAudio'
        };
        const reasonStr = reasonMap[result.reason] || `Unknown(${result.reason})`;
        const details = result.errorDetails || result.cancelDetails?.reason || 'no details';

        reject(new Error(`Speech recognition failed with reason ${reasonStr}. Details: ${details}`));
      },
      (error) => {
        // Ensure mic is properly released
        if (sessionState.recognizer) {
          sessionState.recognizer.close();
          sessionState.recognizer = null;
        }
        reject(new Error(`Microphone error: ${error}`));
      }
    );
  });
}

function speakTextAsync(synthesizer, text, speakerDestination, abortSignal) {
  return new Promise((resolve, reject) => {
    if (!synthesizer) {
      reject(new Error('Synthesizer is not initialized.'));
      return;
    }

    const abortHandler = () => {
      forceStopPlayback();
      reject(new DOMException('aborted', 'AbortError'));
    };

    if (abortSignal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanupAbort = () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    synthesizer.speakTextAsync(
      text,
      (result) => {
        const reasonMap = {
          0: 'NoMatch',
          1: 'Canceled',
          2: 'SynthesizingAudioCompleted',
          3: 'SynthesizingAudio'
        };
        const reasonStr = reasonMap[result.reason] || `Unknown(${result.reason})`;

        // Only complete when final audio is fully synthesized.
        if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
          if (!speakerDestination) {
            cleanupAbort();
            resolve(result);
            return;
          }

          // Wait for actual speaker playback end to avoid overlap with next turn.
          let settled = false;
          const settleOk = () => {
            if (settled) {
              return;
            }
            settled = true;
            cleanupAbort();
            resolve(result);
          };

          const settleTimeout = setTimeout(() => {
            settleOk();
          }, 15000);

          speakerDestination.onAudioEnd = () => {
            clearTimeout(settleTimeout);
            settleOk();
          };
          return;
        }

        appendLog(`[DEBUG] Synthesis reason: ${reasonStr}, cancellation: ${result.errorDetails}`);
        cleanupAbort();
        reject(new Error(`Speech synthesis failed with reason ${reasonStr}. ${result.errorDetails || ''}`.trim()));
      },
      (error) => {
        cleanupAbort();
        reject(new Error(error));
      }
    );
  });
}

async function ensureSessionStarted() {
  if (!SpeechSDK) {
    throw new Error('Azure Speech SDK yuklenemedi.');
  }

  // Check if token is expired (540 seconds = 9 minutes)
  const now = Date.now();
  const tokenExpired = sessionState.tokenExpiryTime && (now >= sessionState.tokenExpiryTime - 30000); // Refresh 30 sec before expiry

  if (sessionState.started && !tokenExpired) {
    return;
  }

  if (tokenExpired) {
    appendLog('Token expired, refreshing session...');
    destroySession();
  }

  const selectedMode = elements.mode.value;
  const selectedLanguage = elements.language.value;

  appendLog(`Starting ${modeLabelMap[selectedMode] || selectedMode} in ${selectedLanguage}`);

  const tokenPayload = await requestSpeechToken();
  appendLog(`Speech token acquired for region ${tokenPayload.region}`);

  // Track token expiry
  sessionState.tokenExpiryTime = Date.now() + (tokenPayload.expiresInSeconds * 1000);

  const speechConfig = createSpeechConfig(tokenPayload);
  sessionState.speechToken = tokenPayload;
  sessionState.speechConfig = speechConfig;
  sessionState.recognizer = createRecognizer(speechConfig);

  if (selectedMode === 'voiceOnly') {
    createVoiceOnlySynthesizer(speechConfig);
    elements.stageHint.hidden = false;
    appendLog('Voice-only synthesizer ready.');
  } else {
    appendLog(`Avatar mode selected: ${modeLabelMap[selectedMode]}`);
    await startAvatarSession(speechConfig);
    appendLog('Avatar stream initialized.');
  }

  sessionState.started = true;
}

async function listenFromMic() {
  await ensureSessionStarted();

  // Recreate recognizer if needed (after previous error)
  if (!sessionState.recognizer) {
    sessionState.recognizer = createRecognizer(sessionState.speechConfig);
    appendLog('[Recognizer recreated after previous session]');
  }

  appendLog('Listening from microphone...');

  try {
    const text = await recognizeOnceAsync(sessionState.recognizer);
    elements.question.value = text;
    appendLog(`Recognized: ${text}`);
  } catch (error) {
    // Recognizer is now closed/invalid, mark for recreation
    sessionState.recognizer = null;
    throw error;
  }
}

async function askAndSpeak() {
  await ensureSessionStarted();

  const selectedLanguage = elements.language.value;
  const question = elements.question.value.trim();
  const effectiveQuestion = question || 'Bu dokumanlar ne anlatiyor?';

  appendLog('Calling RAG service...');
  const answerPayload = await requestAnswer(effectiveQuestion, selectedLanguage);

  setAnswer(answerPayload.answer);
  appendLog(`Answer: ${answerPayload.answer}`);

  if (answerPayload.citations?.length) {
    answerPayload.citations.forEach((citation, index) => {
      appendLog(`Citation ${index + 1}: ${citation.source}`);
    });
  } else {
    appendLog('No citations returned.');
  }

  // For voice-only: recreate synthesizer. For avatar: reuse existing session or restart if lost.
  if (elements.mode.value === 'voiceOnly') {
    closeSynthesizers();
    sessionState.synthesizer = new SpeechSDK.SpeechSynthesizer(sessionState.speechConfig);
  } else if (!sessionState.avatarSynthesizer) {
    await startAvatarSession(sessionState.speechConfig);
  }

  await speakTextAsync(sessionState.synthesizer, answerPayload.answer);
  appendLog('Speech synthesis completed.');
}

async function startSession() {
  try {
    await ensureSessionStarted();
  } catch (error) {
    appendLog(`Session failed: ${error.message}`);
    destroySession();
  }
}

function stopSession() {
  destroySession();
  appendLog('Session stopped.');
}

// Awaitable stop for the avatar synthesizer so the server-side speech queue is
// fully flushed before the next turn speaks. Without this, an interrupted answer
// resumes where it left off instead of answering the new question.
function stopAvatarSpeaking() {
  return new Promise((resolve) => {
    const synth = sessionState.avatarSynthesizer;
    if (!synth?.stopSpeakingAsync) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Safety timeout in case the callback never fires.
    setTimeout(done, 2000);
    synth.stopSpeakingAsync(done, done);
  });
}

function forceStopPlayback() {
  try {
    if (sessionState.synthesizer?.stopSpeakingAsync) {
      sessionState.synthesizer.stopSpeakingAsync(() => {}, () => {});
    }
    if (sessionState.avatarSynthesizer?.stopSpeakingAsync) {
      sessionState.avatarSynthesizer.stopSpeakingAsync(() => {}, () => {});
    }
    if (sessionState.speakerDestination) {
      if (typeof sessionState.speakerDestination.pause === 'function') {
        sessionState.speakerDestination.pause();
      }
      if (typeof sessionState.speakerDestination.close === 'function') {
        sessionState.speakerDestination.close();
      }
      sessionState.speakerDestination = null;
    }
    if (elements.avatarAudio) {
      if (!elements.mode || elements.mode.value === 'voiceOnly') {
        // Voice-only: fully clear audio element.
        elements.avatarAudio.pause();
        elements.avatarAudio.srcObject = null;
      } else {
        // Avatar mode: only mute for instant silence. Do NOT pause() a live
        // MediaStream element — pausing buffers incoming packets and replays the
        // old speech on resume, which made the avatar continue the previous answer.
        // Muting keeps consuming live frames so the next turn starts fresh.
        elements.avatarAudio.muted = true;
      }
    }
  } catch {
    // Ignore stop race conditions.
  }
}

function interruptCurrentTurn() {
  if (currentTurnAbortController) {
    currentTurnAbortController.abort();
    currentTurnAbortController = null;
  }

  forceStopPlayback();

  // For avatar mode: keep the WebRTC synthesizer alive so the connection persists.
  // For voice-only: close the synthesizer as usual.
  if (!elements.mode || elements.mode.value === 'voiceOnly') {
    closeSynthesizers();
  }
  stopRecognizer();
  sessionState.recognizer = null;
  conversationActive = false;
  appendLog('Interruption: response stopped immediately.');
}

function isVoiceLiveActive() {
  return Boolean(voiceLiveSession);
}

async function stopVoiceLive() {
  if (!voiceLiveSession) {
    return;
  }
  const session = voiceLiveSession;
  voiceLiveSession = null;
  try {
    await session.stop();
  } catch (error) {
    appendLog(`Voice Live stop error: ${error.message}`);
  }
  elements.stageHint.hidden = false;
}

async function toggleVoiceLive() {
  if (voiceLiveSession) {
    await stopVoiceLive();
    setMicState('idle');
    appendLog('Voice Live oturumu durduruldu.');
    return;
  }

  if (!backendConfig?.voiceLive?.enabled) {
    appendLog('Voice Live backend tarafinda yapilandirilmamis; standart hatta geciliyor.');
    interruptCurrentTurn();
    setMicState('initializing');
    setTimeout(() => runConversationTurn(), 120);
    return;
  }

  setMicState('initializing');
  appendLog(`Voice Live baslatiliyor (model: ${backendConfig.voiceLive.model}).`);

  const avatarMode = elements.mode?.value === 'videoAvatar';
  const defaultAvatar = avatarCatalog[0] || {};

  voiceLiveSession = new VoiceLiveSession({
    backendBaseUrl: getBackendBaseUrl(),
    language: elements.language.value,
    voice: elements.voice.value,
    avatar: avatarMode,
    character: defaultAvatar.character || 'lisa',
    style: defaultAvatar.style || 'casual-sitting',
    videoEl: elements.avatarVideo,
    audioEl: elements.avatarAudio,
    handlers: {
      onLog: appendLog,
      onUserText: (text) => showQuestion(text),
      onAssistantText: (text) => {
        setAnswer(text);
        showQuestion('');
      },
      onState: (state) => setMicState(state),
      onAvatarStream: () => { elements.stageHint.hidden = true; },
      onError: (message) => appendLog(`Voice Live error: ${message}`),
      onClose: () => {
        voiceLiveSession = null;
        setMicState('idle');
        elements.stageHint.hidden = false;
      }
    }
  });

  if (avatarMode) {
    appendLog(`Avatar realtime ile birlikte: ${defaultAvatar.character || 'lisa'} / ${defaultAvatar.style || 'casual-sitting'}`);
  }

  try {
    await voiceLiveSession.start();
  } catch (error) {
    appendLog(`Voice Live baslatilamadi: ${error.message}`);
    await stopVoiceLive();
    setMicState('idle');
  }
}

setupModes();
loadBackendConfig();

// Collapsible sections
function setupCollapsible(toggleId, panelId) {
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  if (!toggle || !panel) return;

  toggle.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
}

setupCollapsible('settingsToggle', 'settingsPanel');

// Log drawer (right-side slide-in)
function setupLogDrawer() {
  const toggle = document.getElementById('logToggle');
  const panel = document.getElementById('logPanel');
  const scrim = document.getElementById('logScrim');
  const closeBtn = document.getElementById('logClose');
  if (!toggle || !panel) return;

  const setOpen = (open) => {
    panel.classList.toggle('open', open);
    if (scrim) scrim.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
  };

  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
  if (scrim) scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
  });
}

setupLogDrawer();

elements.language.addEventListener('change', () => {
  const previousVoice = elements.voice.value;
  updateVoiceOptionsForLanguage(elements.language.value, previousVoice);
  applyLiveSpeechSettings();
  appendLog(`Language changed: ${elements.language.value}`);
});

elements.voice.addEventListener('change', () => {
  applyLiveSpeechSettings();
  appendLog(`Voice changed: ${elements.voice.value}`);
});

elements.stopButton.addEventListener('click', () => {
  if (isVoiceLiveActive()) {
    stopVoiceLive();
    setMicState('idle');
    appendLog('Voice Live oturumu durduruldu.');
    return;
  }
  interruptCurrentTurn();
  stopSession();
  setMicState('idle');
});

async function runConversationTurn() {
  if (conversationActive) {
    return;
  }

  const turnId = ++currentTurnId;
  const abortController = new AbortController();
  currentTurnAbortController = abortController;
  conversationActive = true;

  try {
    setMicState('initializing');
    await ensureSessionStarted();

    if (turnId !== currentTurnId || abortController.signal.aborted) {
      return;
    }

    // Recreate recognizer if needed
    if (!sessionState.recognizer) {
      sessionState.recognizer = createRecognizer(sessionState.speechConfig);
    }

    setMicState('listening');
    const spokenText = await recognizeOnceAsync(sessionState.recognizer);

    if (!spokenText.trim()) {
      appendLog('Ses algılanamadı, tekrar dene.');
      setMicState('idle');
      return;
    }

    if (turnId !== currentTurnId || abortController.signal.aborted) {
      return;
    }

    elements.question.value = spokenText;
    showQuestion(spokenText);
    appendLog(`Algılanan: ${spokenText}`);

    setMicState('processing');
    const selectedLanguage = elements.language.value;

    const answerPayload = await requestAnswer(spokenText, selectedLanguage, abortController.signal);

    if (turnId !== currentTurnId || abortController.signal.aborted) {
      return;
    }

    setAnswer(answerPayload.answer);
    showQuestion('');
    appendLog(`Cevap: ${answerPayload.answer}`);

    if (answerPayload.citations?.length) {
      answerPayload.citations.forEach((c, i) => appendLog(`Kaynak ${i + 1}: ${c.source}`));
    }

    setMicState('speaking');

    // For voice-only: close and recreate synthesizer each turn.
    // For avatar: keep the WebRTC session alive; restart only if synthesizer was lost.
    if (elements.mode.value === 'voiceOnly') {
      closeSynthesizers();
      createVoiceOnlySynthesizer(sessionState.speechConfig);
    } else {
      if (!sessionState.avatarSynthesizer) {
        appendLog('Avatar synthesizer missing, restarting avatar session...');
        await startAvatarSession(sessionState.speechConfig);
      }
      // Flush any residual server-side speech from a previous (interrupted) turn
      // so the avatar answers the new question instead of resuming the old one.
      await stopAvatarSpeaking();

      if (turnId !== currentTurnId || abortController.signal.aborted) {
        return;
      }

      // Re-enable avatar audio/video that may have been paused by a prior interruption.
      if (elements.avatarAudio) {
        elements.avatarAudio.muted = false;
        elements.avatarAudio.play().catch(() => {});
      }
      if (elements.avatarVideo) {
        elements.avatarVideo.play().catch(() => {});
      }
    }

    await speakTextAsync(sessionState.synthesizer, answerPayload.answer, sessionState.speakerDestination, abortController.signal);

    if (turnId !== currentTurnId || abortController.signal.aborted) {
      return;
    }

    setMicState('idle');
  } catch (error) {
    if (error?.name === 'AbortError') {
      appendLog('Interruption: request aborted.');
    } else {
      appendLog(`Hata: ${error.message}`);
    }
    sessionState.recognizer = null;
    setMicState('idle');
  } finally {
    if (currentTurnAbortController === abortController) {
      currentTurnAbortController = null;
    }
    conversationActive = false;
  }
}

if (elements.micButton) {
  elements.micButton.addEventListener('click', () => {
    // Real-time Voice Live is a continuous session toggled by the mic button.
    if (elements.voiceApi?.value === 'realtime') {
      toggleVoiceLive();
      return;
    }

    // Always prioritize latest user intent: stop any ongoing output first.
    interruptCurrentTurn();

    setMicState('initializing');
    setTimeout(() => {
      runConversationTurn();
    }, 120);
  });
}

if (elements.voiceApi) {
  elements.voiceApi.addEventListener('change', () => {
    appendLog(`Voice API changed: ${elements.voiceApi.value}`);
    // Switching away from realtime should tear down any live session.
    if (elements.voiceApi.value !== 'realtime' && isVoiceLiveActive()) {
      stopVoiceLive();
      setMicState('idle');
    }
  });
}
