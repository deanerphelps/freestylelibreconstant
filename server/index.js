import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { LibreLinkClient } from 'libre-link-unofficial-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_DIR = process.env.HISTORY_DIR || '/app/data';
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 1000);

const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Number(process.env.POLL_MS || process.env.POLL_SECONDS * 1000 || 60_000);

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

function trendArrow(trend) {
  const map = {
    SingleDown: '↓',
    FortyFiveDown: '↘',
    Flat: '→',
    FortyFiveUp: '↗',
    SingleUp: '↑',
    NotComputable: '→',
  };

  if (typeof trend === 'string') return map[trend] || trend || '→';

  return {
    1: '↓',
    2: '↘',
    3: '→',
    4: '↗',
    5: '↑',
  }[trend] || '→';
}

function normalizeReading(reading) {
  return {
    glucose: reading?.value ?? reading?.mgDl ?? reading?.glucose ?? null,
    value: reading?.value ?? reading?.mgDl ?? reading?.glucose ?? null,
    unit: 'mg/dL',
    timestamp: reading?.timestamp instanceof Date
      ? reading.timestamp.toISOString()
      : new Date().toISOString(),
    trend: trendArrow(reading?.trendType ?? reading?.trend),
    trendType: reading?.trendType ?? reading?.trend ?? null,
  };
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

async function pollOnce() {
  try {
    state.status = 'polling';

    const reading = normalizeReading(await client.read());

    if (!reading.glucose) {
      throw new Error('LibreLinkUp returned no glucose value.');
    }

    state.latest = reading;
    state.history.push(reading);
    state.history = state.history.slice(-MAX_HISTORY);

    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(state.history, null, 2)
    );
    state.history = state.history.slice(-1000);

    state.status = 'ok';
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;

    broadcast({ type: 'glucose', data: reading });
    console.log('Updated:', reading.glucose, reading.trend);
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
    const connections = await client.fetchConnections();

    res.json({
      count: connections?.length || 0,
      sampleKeys: connections?.[0] ? Object.keys(connections[0]) : [],
      firstConnection: connections?.[0] || null
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