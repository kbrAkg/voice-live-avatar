import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '..', '..', '.env')
});

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'assistant-app' });
});

app.get('/runtime-config.js', (_req, res) => {
  const config = {
    backendBaseUrl: process.env.BACKEND_BASE_URL || 'http://localhost:8081',
    defaultLanguage: process.env.DEFAULT_LANGUAGE || 'tr-TR',
    enabledModes: {
      voiceOnly: process.env.ENABLE_MODE_VOICE_ONLY !== 'false',
      videoAvatar: process.env.ENABLE_MODE_VIDEO_AVATAR !== 'false'
    }
  };

  res.type('application/javascript').send(`window.__RUNTIME_CONFIG__ = ${JSON.stringify(config, null, 2)};`);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`assistant-app listening on ${port}`);
});
