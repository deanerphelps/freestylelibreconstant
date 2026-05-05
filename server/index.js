import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import LibreLinkUp from 'libre-link-unofficial-api';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, '../public')));

let latest = { glucose: '--', trend: '→', timestamp: Date.now() };

async function poll() {
  try {
    const client = new LibreLinkUp({
      email: process.env.LIBRE_EMAIL,
      password: process.env.LIBRE_PASSWORD,
      region: process.env.LIBRE_REGION
    });

    const reading = await client.read();

    latest = {
      glucose: reading.glucose,
      trend: reading.trendArrow || '→',
      timestamp: Date.now()
    };

    console.log('Updated:', latest);
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

setInterval(poll, (process.env.POLL_SECONDS || 60) * 1000);
poll();

app.get('/api/latest', (req, res) => {
  res.json(latest);
});

app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/watch.html'));
});

app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
