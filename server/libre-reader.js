const DEFAULT_TIME_ZONE = 'America/New_York';

export function trendArrow(trend) {
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

export function normalizeReading(reading) {
  const timestamp = reading?.timestamp instanceof Date
    ? reading.timestamp
    : new Date(reading?.timestamp || Date.now());

  return {
    glucose: reading?.value ?? reading?.mgDl ?? reading?.glucose ?? null,
    value: reading?.value ?? reading?.mgDl ?? reading?.glucose ?? null,
    unit: 'mg/dL',
    timestamp: Number.isFinite(timestamp.getTime())
      ? timestamp.toISOString()
      : new Date().toISOString(),
    trend: trendArrow(reading?.trendType ?? reading?.trend),
    trendType: reading?.trendType ?? reading?.trend ?? null,
  };
}

export function parseLibreLocalTimestamp(value, timeZone = DEFAULT_TIME_ZONE) {
  if (typeof value !== 'string') return new Date(value);

  const match = value.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i
  );
  if (!match) return new Date(value);

  const [, month, day, year, rawHour, minute, second, period] = match;
  let hour = Number(rawHour) % 12;
  if (period.toUpperCase() === 'PM') hour += 12;

  const wallClockMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour,
    Number(minute),
    Number(second)
  );

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(wallClockMs)).map(part => [part.type, part.value])
  );
  const timeZoneWallClockMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = timeZoneWallClockMs - wallClockMs;

  return new Date(wallClockMs - offsetMs);
}

export function normalizeConnectionReading(connection, timeZone = DEFAULT_TIME_ZONE) {
  const item = connection?.glucoseItem;
  const value = item?.ValueInMgPerDl ?? null;
  const sourceDate = parseLibreLocalTimestamp(item?.Timestamp, timeZone);
  const legacyDate = new Date(item?.Timestamp);

  if (
    value === null ||
    value === undefined ||
    !item?.Timestamp ||
    !Number.isFinite(sourceDate.getTime())
  ) {
    return null;
  }

  return {
    glucose: value,
    value,
    unit: 'mg/dL',
    // Keep timestamp compatible with existing history. sourceTimestamp is authoritative.
    timestamp: Number.isFinite(legacyDate.getTime())
      ? legacyDate.toISOString()
      : sourceDate.toISOString(),
    sourceTimestamp: sourceDate.toISOString(),
    trend: trendArrow(item.TrendArrow),
    trendType: item.TrendArrow ?? null,
  };
}

function readingTimestampMs(reading) {
  const timestamp = Date.parse(reading?.sourceTimestamp || reading?.timestamp);
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

export function readingAgeMs(reading, now = Date.now()) {
  const timestamp = readingTimestampMs(reading);
  return Number.isFinite(timestamp) ? now - timestamp : Infinity;
}

function newestReading(left, right) {
  if (!left) return right;
  if (!right) return left;
  return readingTimestampMs(right) > readingTimestampMs(left) ? right : left;
}

function responseConnections(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

export class LibreReader {
  constructor({
    client,
    patientId,
    staleReadingMs = 10 * 60_000,
    refreshMs = 5 * 60_000,
    timeZone = DEFAULT_TIME_ZONE,
    now = () => Date.now(),
    logger = console,
  }) {
    this.client = client;
    this.patientId = patientId;
    this.staleReadingMs = staleReadingMs;
    this.refreshMs = refreshMs;
    this.timeZone = timeZone;
    this.now = now;
    this.logger = logger;
    this.lastRefreshAt = 0;
    this.refreshPromise = null;
  }

  async fetchConnections() {
    // The library caches this response indefinitely. A new sensor can otherwise leave
    // the process attached to the previous connection while authentication is valid.
    this.client.cache?.delete?.('connections');
    const response = await this.client.fetchConnections();
    return { response, connections: responseConnections(response) };
  }

  selectConnection(connections) {
    const available = connections.filter(connection => connection?.glucoseItem?.Timestamp);
    const matching = this.patientId
      ? available.filter(connection => connection?.patientId === this.patientId)
      : available;
    const candidates = matching.length ? matching : available;

    return candidates.sort((left, right) =>
      parseLibreLocalTimestamp(right.glucoseItem.Timestamp, this.timeZone) -
      parseLibreLocalTimestamp(left.glucoseItem.Timestamp, this.timeZone)
    )[0] || null;
  }

  async readAttempt() {
    const { connections } = await this.fetchConnections();
    const selected = this.selectConnection(connections);
    let reading = normalizeConnectionReading(selected, this.timeZone);
    const graphUsesSelectedPatient = Boolean(
      selected?.patientId && connections[0]?.patientId === selected.patientId
    );

    if (
      graphUsesSelectedPatient &&
      (!reading || readingAgeMs(reading, this.now()) > this.staleReadingMs)
    ) {
      try {
        // The graph endpoint can switch to the new sensor before the connection summary does.
        this.client.cache?.delete?.('connections');
        const graphResponse = await this.client.fetchReading();
        const graphReading = normalizeConnectionReading(
          graphResponse?.data?.connection,
          this.timeZone
        );
        reading = newestReading(reading, graphReading);
      } catch (error) {
        this.logger.warn('Libre graph refresh failed.', error?.message || error);
      }
    }

    return reading;
  }

  async reauthenticate() {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        this.client.clearCache();
        await this.client.login();
      })().finally(() => {
        this.refreshPromise = null;
      });
    }

    await this.refreshPromise;
  }

  async readLatest() {
    let reading = null;
    let firstError = null;

    try {
      reading = await this.readAttempt();
    } catch (error) {
      firstError = error;
    }

    const isStale = !reading || readingAgeMs(reading, this.now()) > this.staleReadingMs;
    if (!isStale) return reading;

    const now = this.now();
    if (now - this.lastRefreshAt >= this.refreshMs) {
      this.lastRefreshAt = now;
      this.logger.warn(
        reading
          ? 'Stale Libre reading detected; re-authenticating for a sensor change.'
          : 'Libre connection refresh failed; re-authenticating.',
        firstError?.message || ''
      );

      await this.reauthenticate();
      const refreshedReading = await this.readAttempt();
      reading = newestReading(reading, refreshedReading);
    }

    if (reading) return reading;
    if (firstError) throw firstError;

    return normalizeReading(await this.client.read());
  }
}
