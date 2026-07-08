import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AzureOpenAI } from 'openai';
import { WebSocket, WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '..', '..', '.env')
});

const app = express();
const port = process.env.PORT || 8080;
const managedIdentityClientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = new DefaultAzureCredential(
  managedIdentityClientId ? { managedIdentityClientId } : undefined
);
const cognitiveServicesScope = 'https://cognitiveservices.azure.com/.default';
const azureTokenProvider = getBearerTokenProvider(credential, cognitiveServicesScope);
const openAiApiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';

app.use(cors());
app.use(express.json());

const modeConfig = {
  fallback: 'voice-only',
  enabledModes: {
    voiceOnly: process.env.ENABLE_MODE_VOICE_ONLY !== 'false',
    videoAvatar: process.env.ENABLE_MODE_VIDEO_AVATAR !== 'false'
  }
};

const defaultVoiceCatalog = [
  { locale: 'tr-TR', shortName: 'tr-TR-EmelNeural', label: 'TR - Emel Neural' },
  { locale: 'tr-TR', shortName: 'tr-TR-AhmetNeural', label: 'TR - Ahmet Neural' },
  { locale: 'en-US', shortName: 'en-US-AvaMultilingualNeural', label: 'EN - Ava Multilingual' },
  { locale: 'en-US', shortName: 'en-US-AndrewNeural', label: 'EN - Andrew Neural' }
];

const defaultAvatarCatalog = [
  { id: 'mentor', label: 'Mentor', style: 'casual-sitting' },
  { id: 'facilitator', label: 'Facilitator', style: 'casual-sitting' },
  { id: 'coach', label: 'Coach', style: 'casual-sitting' }
];

function parseJsonArrayEnv(envVarName, fallbackValue) {
  const rawValue = process.env[envVarName];

  if (!rawValue) {
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return fallbackValue;
    }

    return parsed;
  } catch {
    return fallbackValue;
  }
}

function getVoiceCatalog() {
  return parseJsonArrayEnv('AZURE_SPEECH_VOICES_JSON', defaultVoiceCatalog);
}

function getAvatarCatalog() {
  return parseJsonArrayEnv('AZURE_AVATAR_CATALOG_JSON', defaultAvatarCatalog);
}

function hasFoundryConfig() {
  return Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_CHAT_DEPLOYMENT);
}

function buildOpenAiClient() {
  if (!hasFoundryConfig()) {
    return null;
  }

  return new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: openAiApiVersion,
    azureADTokenProvider: azureTokenProvider
  });
}

async function buildSpeechAccessToken() {
  const region = process.env.AZURE_SPEECH_REGION || process.env.AZURE_LOCATION || 'eastus2';
  const aadToken = await azureTokenProvider();

  // Exchange AAD token for Speech STS token using custom subdomain endpoint
  const speechEndpoint = process.env.AZURE_SPEECH_ENDPOINT ||
    `https://${process.env.AZURE_SPEECH_ACCOUNT_NAME || 'spavatarpoc001'}.cognitiveservices.azure.com`;

  const stsResponse = await fetch(
    `${speechEndpoint}/sts/v1.0/issueToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aadToken}`,
        'Content-Length': '0'
      }
    }
  );

  if (!stsResponse.ok) {
    const body = await stsResponse.text();
    throw new Error(`Speech STS token exchange failed with ${stsResponse.status}: ${body}`);
  }

  const speechToken = await stsResponse.text();

  return {
    token: speechToken,
    region,
    expiresInSeconds: 540
  };
}

function getSpeechRegion() {
  return process.env.AZURE_SPEECH_REGION || process.env.AZURE_LOCATION || 'eastus2';
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');

        if (response.statusCode < 200 || response.statusCode >= 300) {
          console.error(`[fetch] ${response.statusCode} response: ${rawBody}`);
          reject(new Error(`Avatar relay token request failed with ${response.statusCode}: ${rawBody}`));
          return;
        }

        try {
          resolve(rawBody ? JSON.parse(rawBody) : {});
        } catch (error) {
          reject(new Error(`Avatar relay token response parse failed: ${error.message}`));
        }
      });
    });

    request.on('error', (error) => reject(error));
    request.end();
  });
}

async function buildAvatarRelayToken() {
  const region = getSpeechRegion();
  const relayUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1`;

  // Keyless: AAD token -> Speech STS (authorization) token -> relay endpoint.
  // Relay endpoint'i ham AAD token'i degil, Speech resource'unun urettigi
  // authorization (STS) token'ini bekler.
  let speechToken;
  try {
    ({ token: speechToken } = await buildSpeechAccessToken());
  } catch (error) {
    const errorMsg = `Avatar relay token failed while acquiring Speech authorization token: ${error.message}`;
    console.error('[Avatar]', errorMsg);
    throw new Error(errorMsg);
  }

  try {
    const payload = await fetchJson(relayUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${speechToken}`
      }
    });

    return {
      region,
      ...payload
    };
  } catch (error) {
    const errorMsg = `Avatar relay token request failed (region ${region}). Ensure the service identity has "Cognitive Services User" on the Speech resource and custom subdomain is enabled. Details: ${error.message}`;
    console.error('[Avatar]', errorMsg);
    throw new Error(errorMsg);
  }
}

function extractTextFromCompletion(response) {
  return response.choices?.[0]?.message?.content?.trim() || 'Yanit alinamadi.';
}

// ---------------------------------------------------------------------------
// Voice Live API (real-time speech-to-speech) proxy
// ---------------------------------------------------------------------------
// The browser cannot securely hold Azure credentials, so it connects to this
// backend over WebSocket. The backend authenticates with managed identity and
// relays the stream to the Azure Voice Live API, injecting the domain-adaptive
// session config and grounding responses via the RAG service (VoiceRAG pattern).

const voiceLiveModel = process.env.AZURE_VOICE_LIVE_MODEL || 'gpt-4o-mini';
const voiceLiveApiVersion = process.env.AZURE_VOICE_LIVE_API_VERSION || '2025-05-01-preview';
const voiceLiveScope = process.env.AZURE_VOICE_LIVE_SCOPE || cognitiveServicesScope;
// Turn/interruption detection. When input_audio_transcription uses the
// azure-speech model, the service requires a semantic VAD (azure_semantic_vad or
// azure_semantic_vad_multilingual); server_vad is rejected. Default to the
// multilingual semantic VAD so barge-in works across languages (e.g. Turkish).
const voiceLiveVadType = process.env.AZURE_VOICE_LIVE_VAD || 'azure_semantic_vad_multilingual';

const searchKnowledgeTool = {
  type: 'function',
  name: 'search_knowledge',
  description: 'Retrieve a grounded answer and citations from the organizational knowledge base. Call this before answering any factual or domain question.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The user question to look up in the knowledge base.'
      }
    },
    required: ['query']
  }
};

function getVoiceLiveHttpEndpoint() {
  const raw = process.env.AZURE_VOICE_LIVE_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || '';
  return raw.replace(/\/$/, '');
}

function hasVoiceLiveConfig() {
  return Boolean(getVoiceLiveHttpEndpoint());
}

function buildVoiceLiveUrl() {
  const httpBase = getVoiceLiveHttpEndpoint();
  const wsBase = httpBase.replace(/^http/i, 'ws');
  return `${wsBase}/voice-live/realtime?api-version=${encodeURIComponent(voiceLiveApiVersion)}&model=${encodeURIComponent(voiceLiveModel)}`;
}

function getDefaultVoiceForLanguage(language) {
  const catalog = getVoiceCatalog();
  const prefix = String(language || '').slice(0, 2).toLowerCase();
  const match = catalog.find((voice) => String(voice.locale || voice.language || '').toLowerCase().startsWith(prefix));
  return (match && (match.shortName || match.name)) || process.env.AZURE_SPEECH_DEFAULT_VOICE || 'en-US-AvaMultilingualNeural';
}

function buildVoiceLiveInstructions(language) {
  const domain = process.env.ASSISTANT_DOMAIN || 'education';
  const profile = process.env.ASSISTANT_PROFILE || 'teacher-default';
  const langInstruction = String(language || '').toLowerCase().startsWith('tr')
    ? 'Kullaniciya Turkce yanit ver.'
    : 'Reply in English.';

  return [
    `You are a multilingual, domain-adaptive voice assistant. Active domain: ${domain}. Active profile: ${profile}.`,
    langInstruction,
    'For any factual or domain-specific question, first call the search_knowledge function to ground your answer in the knowledge base, then answer concisely using only that information and mention the source.',
    'If the knowledge base returns nothing relevant, say so honestly. Never fabricate citations. Keep spoken answers short and natural.'
  ].join(' ');
}

function buildTurnDetection() {
  const detection = {
    type: voiceLiveVadType,
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500
  };

  // interrupt_response / remove_filler_words are only valid for the semantic VADs.
  if (voiceLiveVadType.startsWith('azure_semantic')) {
    detection.remove_filler_words = false;
    detection.interrupt_response = true;
    detection.auto_truncate = true;
  }

  return detection;
}

function buildVoiceLiveSessionUpdate(language, voice, options = {}) {
  const session = {
    modalities: ['text', 'audio'],
    instructions: buildVoiceLiveInstructions(language),
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    input_audio_sampling_rate: 24000,
    input_audio_transcription: { model: 'azure-speech', language },
    input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
    input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
    turn_detection: buildTurnDetection(),
    voice: { name: voice, type: 'azure-standard' },
    tools: [searchKnowledgeTool],
    tool_choice: 'auto'
  };

  // Avatar output (WebRTC). Omitting ice_servers makes the service return its own
  // ICE servers in the session.updated event, which the browser then uses to
  // complete the SDP handshake (session.avatar.connect / session.avatar.connecting).
  if (options.avatar) {
    session.avatar = {
      character: options.character || 'lisa',
      style: options.style || 'casual-sitting',
      customized: false
    };
  }

  return { type: 'session.update', session };
}

async function callKnowledgeBase(query, language) {
  const ragBase = (process.env.MCP_BASE_URL || 'http://localhost:8082').replace(/\/$/, '');
  const response = await fetch(`${ragBase}/mcp/tools/answer_question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: query, language })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`RAG answer_question failed with ${response.status}: ${body}`);
  }

  return response.json();
}

async function maybeHandleFunctionCall(rawData, upstream, language) {
  let message;
  try {
    message = JSON.parse(rawData.toString());
  } catch {
    return;
  }

  const item = message?.item;
  if (message?.type !== 'response.output_item.done' || item?.type !== 'function_call' || item.name !== 'search_knowledge') {
    return;
  }

  let query = '';
  try {
    query = JSON.parse(item.arguments || '{}').query || '';
  } catch {
    query = '';
  }

  let output;
  try {
    const result = await callKnowledgeBase(query, language);
    output = {
      answer: result.answer || '',
      citations: (result.citations || []).map((citation) => citation.source).filter(Boolean)
    };
  } catch (error) {
    console.error('[VoiceLive] Knowledge base call failed:', error.message);
    output = { answer: '', citations: [], error: 'knowledge_base_unavailable' };
  }

  if (upstream.readyState !== upstream.OPEN) {
    return;
  }

  upstream.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: item.call_id,
      output: JSON.stringify(output)
    }
  }));
  upstream.send(JSON.stringify({ type: 'response.create' }));
}

async function handleVoiceLiveConnection(clientWs, req) {
  if (!hasVoiceLiveConfig()) {
    clientWs.close(1011, 'voice_live_not_configured');
    return;
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const language = params.get('language') || process.env.DEFAULT_LANGUAGE || 'tr-TR';
  const voice = params.get('voice') || getDefaultVoiceForLanguage(language);
  const avatarEnabled = params.get('avatar') === 'video' || params.get('avatar') === '1';
  const avatarCharacter = params.get('character') || 'lisa';
  const avatarStyle = params.get('style') || 'casual-sitting';

  const clientQueue = [];
  let upstream;

  try {
    const tokenResponse = await credential.getToken(voiceLiveScope);
    upstream = new WebSocket(buildVoiceLiveUrl(), {
      headers: { Authorization: `Bearer ${tokenResponse.token}` }
    });
  } catch (error) {
    console.error('[VoiceLive] Failed to open upstream:', error.message);
    clientWs.close(1011, 'voice_live_upstream_failed');
    return;
  }

  const closeBoth = () => {
    try { if (clientWs.readyState === clientWs.OPEN) clientWs.close(); } catch { /* noop */ }
    try { if (upstream.readyState === upstream.OPEN) upstream.close(); } catch { /* noop */ }
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify(buildVoiceLiveSessionUpdate(language, voice, {
      avatar: avatarEnabled,
      character: avatarCharacter,
      style: avatarStyle
    })));
    while (clientQueue.length) {
      upstream.send(clientQueue.shift());
    }
  });

  upstream.on('message', (data) => {
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send(data.toString());
    }
    maybeHandleFunctionCall(data, upstream, language).catch((error) => {
      console.error('[VoiceLive] Function-call handling failed:', error.message);
    });
  });

  upstream.on('close', closeBoth);
  upstream.on('error', (error) => {
    console.error('[VoiceLive] Upstream error:', error.message);
    closeBoth();
  });

  clientWs.on('message', (data) => {
    if (upstream.readyState === upstream.OPEN) {
      upstream.send(data.toString());
    } else {
      clientQueue.push(data.toString());
    }
  });

  clientWs.on('close', closeBoth);
  clientWs.on('error', closeBoth);
}

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'orchestration-api',
    configured: {
      speech: Boolean(process.env.AZURE_SPEECH_RESOURCE_ID),
      foundry: hasFoundryConfig()
    }
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    assistantDomain: process.env.ASSISTANT_DOMAIN || 'education',
    assistantProfile: process.env.ASSISTANT_PROFILE || 'teacher-default',
    defaultLanguage: process.env.DEFAULT_LANGUAGE || 'tr-TR',
    modeConfig,
    speech: {
      resourceId: process.env.AZURE_SPEECH_RESOURCE_ID || '',
      accountName: process.env.AZURE_SPEECH_ACCOUNT_NAME || '',
      tokenEndpoint: '/api/speech/token',
      avatarRelayEndpoint: '/api/avatar/relay-token',
      voiceCatalog: getVoiceCatalog()
    },
    avatar: {
      catalog: getAvatarCatalog()
    },
    voiceLive: {
      enabled: hasVoiceLiveConfig(),
      wsPath: '/api/voice-live/ws',
      model: voiceLiveModel
    },
    rag: {
      endpoint: process.env.MCP_BASE_URL || 'http://localhost:8082'
    },
    foundry: {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
      chatDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || ''
    }
  });
});

app.post('/api/speech/token', async (_req, res) => {
  try {
    const tokenPayload = await buildSpeechAccessToken();
    res.json(tokenPayload);
  } catch (error) {
    res.status(500).json({
      error: 'speech_token_failed',
      message: error.message
    });
  }
});

app.post('/api/avatar/relay-token', async (_req, res) => {
  try {
    const relayPayload = await buildAvatarRelayToken();
    res.json(relayPayload);
  } catch (error) {
    res.status(500).json({
      error: 'avatar_relay_token_failed',
      message: error.message
    });
  }
});

app.post('/api/chat/fallback', async (req, res) => {
  const { message, mode, language = 'tr-TR' } = req.body || {};

  if (!message) {
    res.status(400).json({
      error: 'missing_message',
      message: 'message is required'
    });

    return;
  }

  if (!hasFoundryConfig()) {
    res.status(503).json({
      error: 'foundry_not_configured',
      message: 'AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_CHAT_DEPLOYMENT must be configured.'
    });

    return;
  }

  try {
    const client = buildOpenAiClient();
    const completion = await client.chat.completions.create({
      model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT,
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `You are a multilingual domain-adaptive assistant. Active domain: ${process.env.ASSISTANT_DOMAIN || 'education'}. Active profile: ${process.env.ASSISTANT_PROFILE || 'teacher-default'}. Reply in ${language}. Keep the answer concise and safe.`
        },
        {
          role: 'user',
          content: message
        }
      ]
    });

    res.json({
      mode: mode || 'voice-only',
      answer: extractTextFromCompletion(completion),
      citations: [],
      model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT
    });
  } catch (error) {
    res.status(500).json({
      error: 'chat_fallback_failed',
      message: error.message
    });
  }
});

const server = app.listen(port, () => {
  console.log(`orchestration-api listening on ${port}`);
});

const voiceLiveWss = new WebSocketServer({ server, path: '/api/voice-live/ws' });
voiceLiveWss.on('connection', (clientWs, req) => {
  handleVoiceLiveConnection(clientWs, req).catch((error) => {
    console.error('[VoiceLive] Connection handler failed:', error.message);
    try { clientWs.close(); } catch { /* noop */ }
  });
});
