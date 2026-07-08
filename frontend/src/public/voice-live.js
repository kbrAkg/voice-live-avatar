// Real-time Voice Live API client.
//
// Streams microphone PCM16 audio to the backend Voice Live proxy over a
// WebSocket and plays back the model's PCM16 audio response. The backend owns
// authentication, session configuration, and RAG grounding, so this module only
// handles audio capture, playback, transcripts, and barge-in.

const SAMPLE_RATE = 24000;

function floatTo16BitPcm(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export class VoiceLiveSession {
  constructor({ backendBaseUrl, language, voice, avatar = false, character = 'lisa', style = 'casual-sitting', videoEl = null, audioEl = null, handlers = {} }) {
    this.backendBaseUrl = backendBaseUrl;
    this.language = language;
    this.voice = voice;
    this.avatar = avatar;
    this.character = character;
    this.style = style;
    this.videoEl = videoEl;
    this.audioEl = audioEl;
    this.handlers = handlers;

    this.ws = null;
    this.mediaStream = null;
    this.inputContext = null;
    this.processor = null;
    this.sourceNode = null;

    this.outputContext = null;
    this.playbackTime = 0;
    this.activeSources = [];

    this.peerConnection = null;
    this.assistantText = '';
    this.stopped = false;
  }

  log(line) {
    this.handlers.onLog?.(line);
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  async start() {
    const wsBase = this.backendBaseUrl.replace(/^http/i, 'ws').replace(/\/$/, '');
    const query = new URLSearchParams({ language: this.language, voice: this.voice });
    if (this.avatar) {
      query.set('avatar', 'video');
      query.set('character', this.character);
      query.set('style', this.style);
    }
    const wsUrl = `${wsBase}/api/voice-live/ws?${query.toString()}`;

    // Acquire the microphone before opening the socket so failures surface early.
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    // Audio playback context is only needed for the non-avatar (PCM) path;
    // in avatar mode audio arrives via the WebRTC audio track.
    if (!this.avatar) {
      this.outputContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }

    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.log('Voice Live connected.');
        this.startMicrophoneStreaming();
        this.handlers.onState?.('listening');
        resolve();
      };

      this.ws.onmessage = (event) => this.handleServerEvent(event.data);

      this.ws.onerror = () => {
        this.handlers.onError?.('WebSocket error');
        reject(new Error('Voice Live WebSocket error'));
      };

      this.ws.onclose = () => {
        if (!this.stopped) {
          this.log('Voice Live connection closed.');
          this.stop();
          this.handlers.onClose?.();
        }
      };
    });
  }

  startMicrophoneStreaming() {
    this.inputContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    this.sourceNode = this.inputContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.inputContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (event) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const pcm = floatTo16BitPcm(input);
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: arrayBufferToBase64(pcm)
      }));
    };

    this.sourceNode.connect(this.processor);
    this.processor.connect(this.inputContext.destination);
  }

  handleServerEvent(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    switch (message.type) {
      case 'session.updated':
        this.log('Voice Live session ready.');
        if (this.avatar && !this.peerConnection) {
          const avatarInfo = message.session?.avatar || {};
          const iceServers = avatarInfo.ice_servers || avatarInfo.iceServers || [];
          this.setupAvatarWebRTC(iceServers).catch((error) => {
            this.handlers.onError?.(`Avatar WebRTC setup failed: ${error.message}`);
          });
        }
        break;

      case 'session.avatar.connecting':
        this.handleAvatarAnswer(message.server_sdp || message.serverSdp);
        break;

      case 'input_audio_buffer.speech_started':
        // Barge-in: user started talking. Silence any queued/streaming assistant
        // audio immediately so the new question takes priority.
        this.flushPlayback();
        if (this.avatar && this.audioEl) {
          this.audioEl.muted = true;
        }
        this.handlers.onState?.('listening');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (message.transcript) {
          this.handlers.onUserText?.(message.transcript.trim());
        }
        break;

      case 'response.audio_transcript.delta':
        this.assistantText += message.delta || '';
        this.handlers.onAssistantText?.(this.assistantText);
        break;

      case 'response.audio_transcript.done':
        if (message.transcript) {
          this.assistantText = message.transcript;
          this.handlers.onAssistantText?.(this.assistantText);
        }
        break;

      case 'response.audio.delta':
        // In avatar mode the audio is delivered through the WebRTC audio track,
        // so skip the PCM playback path to avoid double audio.
        if (message.delta && !this.avatar) {
          this.handlers.onState?.('speaking');
          this.enqueueAudio(message.delta);
        } else if (message.delta && this.avatar) {
          this.handlers.onState?.('speaking');
        }
        break;

      case 'response.created':
        this.assistantText = '';
        // New answer starting: re-enable avatar audio muted during barge-in.
        if (this.avatar && this.audioEl) {
          this.audioEl.muted = false;
          this.audioEl.play?.().catch(() => {});
        }
        break;

      case 'response.done':
        this.handlers.onState?.('listening');
        break;

      case 'error':
        this.handlers.onError?.(message.error?.message || 'Voice Live error');
        this.log(`Voice Live error: ${message.error?.message || 'unknown'}`);
        break;

      default:
        break;
    }
  }

  enqueueAudio(base64Audio) {
    const int16 = base64ToInt16Array(base64Audio);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 0x8000;
    }

    const buffer = this.outputContext.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputContext.destination);

    const now = this.outputContext.currentTime;
    const startAt = Math.max(now, this.playbackTime);
    source.start(startAt);
    this.playbackTime = startAt + buffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source);
    };
  }

  flushPlayback() {
    this.activeSources.forEach((source) => {
      try { source.stop(); } catch { /* already stopped */ }
    });
    this.activeSources = [];
    this.playbackTime = this.outputContext ? this.outputContext.currentTime : 0;
  }

  // --- Avatar WebRTC ---------------------------------------------------------
  waitForIceGathering(pc, timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        pc.removeEventListener('icecandidate', onCandidate);
        resolve();
      };
      const onCandidate = (event) => {
        if (!event.candidate) done();
      };
      pc.addEventListener('icecandidate', onCandidate);
      setTimeout(done, timeoutMs);
    });
  }

  async setupAvatarWebRTC(iceServers) {
    const rtcIceServers = (iceServers || []).map((server) => ({
      urls: server.urls,
      username: server.username || undefined,
      credential: server.credential || undefined
    }));

    const pc = new RTCPeerConnection(rtcIceServers.length ? { iceServers: rtcIceServers } : undefined);
    this.peerConnection = pc;

    // Avatar streams are receive-only.
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      if (event.track.kind === 'video' && this.videoEl) {
        this.videoEl.srcObject = stream;
        this.videoEl.muted = true; // audio plays via the audio element
        this.videoEl.play?.().catch(() => {});
        this.handlers.onAvatarStream?.('video');
        this.log('Avatar video track connected.');
      }
      if (event.track.kind === 'audio' && this.audioEl) {
        this.audioEl.srcObject = stream;
        this.audioEl.muted = false;
        this.audioEl.play?.().catch(() => {});
        this.log('Avatar audio track connected.');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc);

    this.send({
      type: 'session.avatar.connect',
      client_sdp: btoa(JSON.stringify(pc.localDescription))
    });
    this.log('Avatar SDP offer sent.');
  }

  async handleAvatarAnswer(serverSdpBase64) {
    if (!this.peerConnection || !serverSdpBase64) {
      return;
    }
    try {
      const answer = JSON.parse(atob(serverSdpBase64));
      await this.peerConnection.setRemoteDescription(answer);
      this.log('Avatar SDP answer applied.');
    } catch (error) {
      this.handlers.onError?.(`Avatar SDP answer failed: ${error.message}`);
    }
  }

  async stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    this.flushPlayback();

    if (this.peerConnection) {
      try {
        this.peerConnection.getReceivers().forEach((receiver) => receiver.track?.stop());
        this.peerConnection.close();
      } catch { /* noop */ }
      this.peerConnection = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
    }

    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.inputContext) {
      try { await this.inputContext.close(); } catch { /* noop */ }
      this.inputContext = null;
    }
    if (this.outputContext) {
      try { await this.outputContext.close(); } catch { /* noop */ }
      this.outputContext = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }
}
