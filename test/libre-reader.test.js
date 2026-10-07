import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LibreReader,
  newestVersion,
  parseLibreLocalTimestamp,
  readingAgeMs,
} from '../server/libre-reader.js';

const NOW = Date.parse('2026-09-02T18:00:00.000Z');

test('raises an outdated configured LibreLinkUp version to the supported minimum', () => {
  assert.equal(newestVersion('4.16.0', '5.1.1'), '5.1.1');
  assert.equal(newestVersion('5.2.0', '5.1.1'), '5.2.0');
  assert.equal(newestVersion(undefined, '5.1.1'), '5.1.1');
});

test('expired JWT is removed before immediate login, even within refresh cooldown', async () => {
  const client = fakeClient({ beforeLogin: connection('9/2/2026 1:58:00 PM', 125) });
  client.accessToken = 'expired-token';
  const baseFetch = client.fetchConnections.bind(client);
  client.fetchConnections = async () => {
    if (client.accessToken === 'expired-token') {
      throw new Error('status 401. invalid or expired jwt');
    }
    return baseFetch();
  };
  const baseLogin = client.login.bind(client);
  client.login = async () => {
    assert.equal(client.accessToken, null, 'login must not send the expired token');
    await baseLogin();
  };
  const reader = new LibreReader({
    client, now: () => NOW,
    sleep: async () => assert.fail('auth recovery should not delay'),
    logger: { warn() {} },
  });
  reader.lastRefreshAt = NOW;
  assert.equal((await reader.readLatest()).glucose, 125);
  assert.equal(client.loginCount, 1);
});

test('a temporary login failure can recover on the next poll', async () => {
  const client = fakeClient({ beforeLogin: connection('9/2/2026 1:58:00 PM', 125) });
  const baseFetch = client.fetchConnections.bind(client);
  let authenticated = false;
  client.fetchConnections = async () => {
    if (!authenticated) throw new Error('status 401. invalid or expired jwt');
    return baseFetch();
  };
  let attempts = 0;
  client.login = async () => {
    if (++attempts === 1) throw new Error('temporary login failure');
    authenticated = true;
  };
  const reader = new LibreReader({ client, now: () => NOW, logger: { warn() {} } });
  await assert.rejects(reader.readLatest(), /temporary login failure/);
  assert.equal((await reader.readLatest()).glucose, 125);
  assert.equal(attempts, 2);
});

function connection(timestamp, glucose = 120, patientId = 'patient-1') {
  return {
    patientId,
    glucoseItem: {
      Timestamp: timestamp,
      ValueInMgPerDl: glucose,
      TrendArrow: 3,
    },
  };
}

function response(item) {
  return { data: Array.isArray(item) ? item : [item] };
}

function fakeClient({ beforeLogin, afterLogin = beforeLogin, graphBefore, graphAfter }) {
  let loggedIn = false;
  return {
    cache: new Map([['connections', response(beforeLogin)]]),
    clearCount: 0,
    loginCount: 0,
    clearCache() {
      this.clearCount += 1;
      this.cache.clear();
    },
    async login() {
      this.loginCount += 1;
      loggedIn = true;
    },
    async fetchConnections() {
      return response(loggedIn ? afterLogin : beforeLogin);
    },
    async fetchReading() {
      const item = loggedIn ? graphAfter : graphBefore;
      if (!item) throw new Error('No graph response');
      return { data: { connection: item } };
    },
    async read() {
      throw new Error('Unexpected fallback');
    },
  };
}

test('parses Libre local timestamps using Eastern daylight time', () => {
  assert.equal(
    parseLibreLocalTimestamp('9/2/2026 1:58:00 PM').toISOString(),
    '2026-09-02T17:58:00.000Z'
  );
});

test('reauthenticates when a successful response is stale after a sensor change', async () => {
  const stale = connection('9/2/2026 1:30:00 PM', 118);
  const fresh = connection('9/2/2026 1:58:00 PM', 123);
  const client = fakeClient({
    beforeLogin: stale,
    afterLogin: fresh,
    graphBefore: stale,
    graphAfter: fresh,
  });
  const reader = new LibreReader({
    client,
    now: () => NOW,
    sleep: async () => {},
    logger: { warn() {} },
  });

  const reading = await reader.readLatest();

  assert.equal(reading.glucose, 123);
  assert.equal(readingAgeMs(reading, NOW), 2 * 60_000);
  assert.equal(client.loginCount, 1);
  assert.equal(client.clearCount, 1);
});

test('retries a stale response before reauthenticating or returning no recent data', async () => {
  const stale = connection('9/2/2026 1:30:00 PM', 118);
  const fresh = connection('9/2/2026 1:58:00 PM', 124);
  let connectionFetches = 0;
  const sleepDelays = [];
  const client = {
    cache: new Map(),
    loginCount: 0,
    clearCache() {},
    async login() {
      this.loginCount += 1;
    },
    async fetchConnections() {
      connectionFetches += 1;
      return response(connectionFetches === 1 ? stale : fresh);
    },
    async fetchReading() {
      return { data: { connection: stale } };
    },
  };
  const reader = new LibreReader({
    client,
    now: () => NOW,
    retryDelayMs: 15_000,
    sleep: async delayMs => sleepDelays.push(delayMs),
    logger: { warn() {} },
  });

  const reading = await reader.readLatest();

  assert.equal(reading.glucose, 124);
  assert.deepEqual(sleepDelays, [15_000]);
  assert.equal(client.loginCount, 0);
});

test('uses the graph reading when the connection summary still shows the old sensor', async () => {
  const stale = connection('9/2/2026 1:30:00 PM', 118);
  const freshGraph = connection('9/2/2026 1:58:00 PM', 126);
  const client = fakeClient({
    beforeLogin: stale,
    graphBefore: freshGraph,
  });
  const reader = new LibreReader({
    client,
    now: () => NOW,
    sleep: async () => {},
    logger: { warn() {} },
  });

  const reading = await reader.readLatest();

  assert.equal(reading.glucose, 126);
  assert.equal(client.loginCount, 0);
});

test('does not reauthenticate for a fresh connection reading', async () => {
  const fresh = connection('9/2/2026 1:58:00 PM', 121);
  const client = fakeClient({ beforeLogin: fresh });
  const reader = new LibreReader({ client, now: () => NOW, logger: { warn() {} } });

  const reading = await reader.readLatest();

  assert.equal(reading.glucose, 121);
  assert.equal(client.loginCount, 0);
  assert.equal(client.cache.has('connections'), false);
});

test('keeps an explicitly configured patient selected', async () => {
  const configured = connection('9/2/2026 1:57:00 PM', 119, 'patient-1');
  const other = connection('9/2/2026 1:59:00 PM', 140, 'patient-2');
  const client = fakeClient({ beforeLogin: [other, configured] });
  const reader = new LibreReader({
    client,
    patientId: 'patient-1',
    now: () => NOW,
    sleep: async () => {},
    logger: { warn() {} },
  });

  const reading = await reader.readLatest();

  assert.equal(reading.glucose, 119);
});

test('does not use another patient graph when the configured patient is stale', async () => {
  const configured = connection('9/2/2026 1:30:00 PM', 119, 'patient-1');
  const other = connection('9/2/2026 1:59:00 PM', 140, 'patient-2');
  const client = fakeClient({
    beforeLogin: [other, configured],
    graphBefore: other,
  });
  const reader = new LibreReader({
    client,
    patientId: 'patient-1',
    now: () => NOW,
    sleep: async () => {},
    logger: { warn() {} },
  });

  const reading = await reader.readLatest();

  assert.equal(reading.glucose, 119);
  assert.equal(client.loginCount, 1);
});
