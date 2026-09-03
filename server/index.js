import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { LibreLinkClient } from 'libre-link-unofficial-api';
import { LibreReader, readingAgeMs } from './libre-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_DIR = process.env.HISTORY_DIR || '/app/data';
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 1000);

const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Number(process.env.POLL_MS || process.env.POLL_SECONDS * 1000 || 60_000);
const STALE_READING_MS = Number(process.env.STALE_READING_MS || 10 * 60_000);
const CONNECTION_REFRESH_MS = Number(process.env.CONNECTION_REFRESH_MS || 5 * 60_000);

if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, '[]');
}

const client = new LibreLinkClient({
  email: process.env.LIBRE_EMAIL,
  password: process.env.LIBRE_PASSWORD,
  patientId: process.env.LIBRE_PATIENT_ID || undefined,
  lluVersion: process.env.LIBRE_LINK_UP_VERSION || '4.16.0',
});

const libreReader = new LibreReader({
  client,
  patientId: process.env.LIBRE_PATIENT_ID || undefined,
  staleReadingMs: STALE_READING_MS,
  refreshMs: CONNECTION_REFRESH_MS,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const state = {
  status: 'starting',
  latest: null,
  history: JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')),
  lastError: null,
  lastSuccessAt: null,
};

state.latest = state.history.at(-1) || null;

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

async function pollOnce() {
  try {
    state.status = 'polling';

    const reading = await libreReader.readLatest();

    if (!reading.glucose) {
      throw new Error('LibreLinkUp returned no glucose value.');
    }

    const ageMs = readingAgeMs(reading);
    if (ageMs > STALE_READING_MS) {
      const staleMinutes = Math.floor(ageMs / 60_000);
      throw new Error(`LibreLinkUp returned a stale reading (${staleMinutes} minutes old).`);
    }

    const isNewReading =
      !state.latest ||
      reading.timestamp !== state.latest.timestamp ||
      reading.glucose !== state.latest.glucose;

    state.latest = reading;

    state.status = 'ok';
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;

    if (isNewReading) {
      state.history.push(reading);
      state.history = state.history.slice(-MAX_HISTORY);

      fs.writeFileSync(
        HISTORY_FILE,
        JSON.stringify(state.history, null, 2)
      );

      broadcast({ type: 'glucose', data: reading });
      console.log('Updated:', reading.glucose, reading.trend);
    } else {
      console.log('No new Libre reading yet.');
    }
  } catch (err) {
    state.status = 'error';
    state.lastError = {
      message: err?.message || String(err),
      at: new Date().toISOString(),
    };

    console.error('[Libre poll error]', state.lastError.message);
    broadcast({ type: 'error', error: state.lastError });
  }
}

app.get('/api/latest', (_req, res) => {
  if (!state.latest) return res.status(503).json({ error: 'No reading yet', state });
  res.json(state.latest);
});

app.get('/api/history', (_req, res) => {
  res.json(state.history);
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: state.status,
    latest: state.latest,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    historyCount: state.history.length,
  });
});

app.get('/watch', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'watch.html'));
});

app.get('/api/libre-debug', async (_req, res) => {
  try {
    const { connections } = await libreReader.fetchConnections();
    const configuredPatientId = process.env.LIBRE_PATIENT_ID;

    res.json({
      count: connections.length,
      hasConfiguredPatientId: Boolean(configuredPatientId),
      connections: connections.map((connection, index) => ({
        index,
        matchesConfiguredPatient: configuredPatientId
          ? connection?.patientId === configuredPatientId
          : null,
        glucose: connection?.glucoseItem?.ValueInMgPerDl ?? null,
        timestamp: connection?.glucoseItem?.Timestamp ?? null,
        trend: connection?.glucoseItem?.TrendArrow ?? null
      }))
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || String(err)
    });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Libre dashboard running on port ${PORT}`);

  try {
    state.status = 'logging_in';
    await client.login();

    state.status = 'logged_in';
    await pollOnce();

    setInterval(pollOnce, POLL_MS);
  } catch (err) {
    state.status = 'error';
    state.lastError = {
      message: err?.message || String(err),
      at: new Date().toISOString(),
    };

    console.error('[Libre login error]', state.lastError.message);
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', data: { status: state.status } }));
  if (state.latest) ws.send(JSON.stringify({ type: 'glucose', data: state.latest }));
});
