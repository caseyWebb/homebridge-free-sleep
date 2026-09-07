/**
 * A stateful in-process mock Pod on `node:http`, seeded from `test/fixtures/`.
 *
 * This is the executable spec for `PodClient` (openspec/changes/pod-client/design.md,
 * "The mock is a `node:http` server, not MSW"): it reproduces free-sleep's actual write
 * semantics — the truthiness guards, the 12-hour power-on duration, the away-mode mirroring,
 * the fixed command ordering — rather than an idealised API, citing
 * `server/src/routes/deviceStatus/updateDeviceStatus.ts` and
 * `server/src/routes/settings/settings.ts` at v2.1.5 / `dc0c710` throughout.
 *
 * Deliberately implements **no plugin policy**: no write deduplication, no away-mode guard,
 * no coalescing. Those are the policies later changes (#10, #12, #13) test *against* this
 * mock's recording, so the mock must apply every write it is given, honestly.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AlarmRequestSchema,
  DeviceStatusSchema,
  PresenceSchema,
  SchedulesSchema,
  ServerStatusSchema,
  ServicesSchema,
  SettingsPatchSchema,
  SettingsSchema,
  UpstreamDeviceStatusPatchSchema,
  VitalsResponseSchema,
  type AlarmRequest,
  type DeviceStatus,
  type DeviceStatusPatch,
  type PresenceData,
  type Schedules,
  type ServerStatus,
  type Services,
  type Settings,
  type Side,
  type SideStatus,
  type VitalsResponse,
} from '../src/pod/types.js';
import { loadFixture } from './loadFixture.js';

// ---------------------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------------------

export interface Command {
  /** The name upstream passes to `executeFunction` — e.g. `'LEFT_TEMP_DURATION'`, `'PRIME'`. */
  name: string;
  /** Present for per-side commands; absent for top-level ones (`PRIME`, `SET_SETTINGS`). */
  side?: Side;
  /** The string argument `executeFunction` was called with, when there is one. */
  value?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  status: number;
  at: number;
}

export type FaultKind = 'status' | 'hang' | 'hangMidBody' | 'reset';

export interface FaultOptions {
  kind: FaultKind;
  /** Only meaningful for `kind: 'status'`. Defaults to 500. */
  status?: number | undefined;
  times: number;
}

/**
 * Internal side-status representation: `isOn` is never stored, only derived on read.
 *
 * `SideStatus` is now inferred from a plain (strip-mode, not `.passthrough()`) zod object —
 * see types.ts's N1 note — so it carries concrete field types rather than an index signature,
 * and `Omit` works as expected without collapsing every field to `unknown`.
 */
type MockSideStatus = Omit<SideStatus, 'isOn'>;

interface MockDeviceStatusState {
  left: MockSideStatus;
  right: MockSideStatus;
  waterLevel: string;
  isPriming: boolean;
  settings: DeviceStatus['settings'];
  coverVersion: string;
  hubVersion: string;
  freeSleep: DeviceStatus['freeSleep'];
  wifiStrength: number;
}

export interface MockPodState {
  deviceStatus: MockDeviceStatusState;
  settings: Settings;
  schedules: Schedules;
  services: Services;
  serverStatus: ServerStatus;
  /** Occupancy change (#19). */
  presence: PresenceData;
  /** Occupancy change (#19). */
  vitals: VitalsResponse;
}

interface SideStatusOverride {
  currentTemperatureLevel?: number;
  currentTemperatureF?: number;
  targetTemperatureF?: number;
  secondsRemaining?: number;
  isAlarmVibrating?: boolean;
}

interface DeviceStatusOverride {
  left?: SideStatusOverride;
  right?: SideStatusOverride;
  waterLevel?: string;
  isPriming?: boolean;
}

interface SideSettingsOverride {
  name?: string;
  awayMode?: boolean;
}

interface SettingsOverride {
  left?: SideSettingsOverride;
  right?: SideSettingsOverride;
  timeZone?: string;
  temperatureFormat?: 'celsius' | 'fahrenheit';
  rebootDaily?: boolean;
}

export interface StartMockPodOptions {
  state?: {
    deviceStatus?: DeviceStatusOverride;
    settings?: SettingsOverride;
    /** Whole-document override; no partial-merge convenience needed by any current test. */
    schedules?: Schedules;
    /** Whole-document override; no partial-merge convenience needed by any current test. */
    services?: Services;
    /** Whole-document override; mirrors the existing `services`/`schedules` convention
     * (`hub-accessory`, pod-test-double spec's "mock serves subsystem health" requirement). */
    serverStatus?: ServerStatus;
    /** Whole-document override; no partial-merge convenience needed (occupancy change, #19). */
    presence?: PresenceData;
    /** Whole-array override; no partial-merge convenience needed (occupancy change, #19). */
    vitals?: VitalsResponse;
  };
}

export interface MockPod {
  url: string;
  /** Live, readable and writable by the test directly — see design.md, "Mock shape". */
  state: MockPodState;
  requests: RecordedRequest[];
  commands: Command[];
  fault(endpoint: string, options: FaultOptions): void;
  /**
   * `alarm-events` (#16): fault-injection-style — mutates `state.deviceStatus[side]
   * .isAlarmVibrating` directly, no HTTP round trip, no recorded command or request (design.md,
   * "Mock Pod: one fault-injection-style addition, no scheduler of its own"). The mock has no
   * `alarmScheduler.ts` equivalent of its own (this file's own module doc: "Deliberately
   * implements no plugin policy"), so this is how a test simulates "the Pod's own scheduler just
   * fired an alarm" — server-side state this plugin's own writes never produce.
   */
  setAlarmVibrating(side: Side, value: boolean): void;
  reset(): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Small internal utilities
// ---------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursive plain-object merge — a local equivalent of upstream's own `mergeDeep`. */
function deepMergeInto(
  base: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!patch) return base;
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const patchValue = patch[key];
    const baseValue = result[key];
    result[key] =
      isPlainObject(patchValue) && isPlainObject(baseValue)
        ? deepMergeInto(baseValue, patchValue)
        : patchValue;
  }
  return result;
}

function toMockSideStatus(side: SideStatus): MockSideStatus {
  return {
    currentTemperatureLevel: side.currentTemperatureLevel,
    currentTemperatureF: side.currentTemperatureF,
    targetTemperatureF: side.targetTemperatureF,
    secondsRemaining: side.secondsRemaining,
    isAlarmVibrating: side.isAlarmVibrating,
    ...(side.taps !== undefined ? { taps: side.taps } : {}),
  };
}

function serializeSideStatus(side: MockSideStatus): SideStatus {
  return { ...side, isOn: side.secondsRemaining > 0 };
}

function serializeDeviceStatus(deviceStatus: MockDeviceStatusState): DeviceStatus {
  return {
    left: serializeSideStatus(deviceStatus.left),
    right: serializeSideStatus(deviceStatus.right),
    waterLevel: deviceStatus.waterLevel,
    isPriming: deviceStatus.isPriming,
    settings: { ...deviceStatus.settings },
    coverVersion: deviceStatus.coverVersion,
    hubVersion: deviceStatus.hubVersion,
    freeSleep: { ...deviceStatus.freeSleep },
    wifiStrength: deviceStatus.wifiStrength,
  };
}

/**
 * `calculateLevelFromF`, copied verbatim from
 * `server/src/routes/deviceStatus/updateDeviceStatus.ts` — used only to compute the string
 * argument recorded for `TEMP_LEVEL_LEFT`/`TEMP_LEVEL_RIGHT` commands.
 */
function calculateLevelFromF(temperatureF: number): number {
  const level = ((temperatureF - 82.5) / 27.5) * 100;
  return Math.round(level);
}

// ---------------------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------------------

function buildInitialState(overrides?: StartMockPodOptions['state']): MockPodState {
  const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
  const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
  const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
  const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));
  const serverStatusFixture = ServerStatusSchema.parse(loadFixture('serverStatus.json'));
  const presenceFixture = PresenceSchema.parse(loadFixture('metricsPresence.json'));
  const vitalsFixture = VitalsResponseSchema.parse(loadFixture('metricsVitals.json'));

  const mergedDeviceStatus = deepMergeInto(
    deviceStatusFixture as unknown as Record<string, unknown>,
    overrides?.deviceStatus as unknown as Record<string, unknown> | undefined,
  ) as unknown as DeviceStatus;
  const mergedSettings = overrides?.settings
    ? (deepMergeInto(
        settingsFixture as unknown as Record<string, unknown>,
        overrides.settings as unknown as Record<string, unknown>,
      ) as unknown as Settings)
    : settingsFixture;
  const schedules = overrides?.schedules ?? schedulesFixture;
  const services = overrides?.services ?? servicesFixture;
  const serverStatus = overrides?.serverStatus ?? serverStatusFixture;
  const presence = overrides?.presence ?? presenceFixture;
  const vitals = overrides?.vitals ?? vitalsFixture;

  return {
    deviceStatus: {
      left: toMockSideStatus(mergedDeviceStatus.left),
      right: toMockSideStatus(mergedDeviceStatus.right),
      waterLevel: mergedDeviceStatus.waterLevel,
      isPriming: mergedDeviceStatus.isPriming,
      settings: { ...mergedDeviceStatus.settings },
      coverVersion: mergedDeviceStatus.coverVersion,
      hubVersion: mergedDeviceStatus.hubVersion,
      freeSleep: { ...mergedDeviceStatus.freeSleep },
      wifiStrength: mergedDeviceStatus.wifiStrength,
    },
    settings: mergedSettings,
    schedules,
    services,
    serverStatus,
    presence,
    vitals,
  };
}

// ---------------------------------------------------------------------------------------
// Write semantics — the five behaviours (design.md, "Mock shape and the command log")
// ---------------------------------------------------------------------------------------

function updateSide(
  state: MockPodState,
  side: Side,
  patch: NonNullable<DeviceStatusPatch['left']>,
  commands: Command[],
): void {
  const controlBothSides = state.settings.left.awayMode || state.settings.right.awayMode;
  const updateLeft = side === 'left' || controlBothSides;
  const updateRight = side === 'right' || controlBothSides;
  const { isOn, targetTemperatureF, secondsRemaining, isAlarmVibrating } = patch;

  // isOn: true -> 43200s (12h); isOn: false -> 0s. Power state is never stored — every read
  // derives it as secondsRemaining > 0 (design.md, "Mock shape and the command log").
  if (isOn !== undefined) {
    const onDuration = isOn ? 43200 : 0;
    if (updateLeft) {
      state.deviceStatus.left.secondsRemaining = onDuration;
      commands.push({ name: 'LEFT_TEMP_DURATION', side: 'left', value: String(onDuration) });
    }
    if (updateRight) {
      state.deviceStatus.right.secondsRemaining = onDuration;
      commands.push({ name: 'RIGHT_TEMP_DURATION', side: 'right', value: String(onDuration) });
    }
  }

  // Truthiness guard copied verbatim: `if (targetTemperatureF)` — 0 is out of range anyway,
  // so this is harmless, but it is the same bug upstream has.
  if (targetTemperatureF) {
    const level = calculateLevelFromF(targetTemperatureF);
    if (updateLeft) {
      state.deviceStatus.left.targetTemperatureF = targetTemperatureF;
      commands.push({ name: 'TEMP_LEVEL_LEFT', side: 'left', value: String(level) });
    }
    if (updateRight) {
      state.deviceStatus.right.targetTemperatureF = targetTemperatureF;
      commands.push({ name: 'TEMP_LEVEL_RIGHT', side: 'right', value: String(level) });
    }
  }

  // Truthiness guard copied verbatim: `if (secondsRemaining)` — secondsRemaining: 0 is a
  // silent no-op. This runs *after* the isOn block, so an explicit duration in the same
  // patch overwrites the 12h/0 the isOn block just set (docs/POD-API.md: "never put isOn
  // and secondsRemaining in the same patch").
  if (secondsRemaining) {
    const seconds = Math.round(secondsRemaining);
    if (updateLeft) {
      state.deviceStatus.left.secondsRemaining = seconds;
      commands.push({ name: 'LEFT_TEMP_DURATION', side: 'left', value: String(seconds) });
    }
    if (updateRight) {
      state.deviceStatus.right.secondsRemaining = seconds;
      commands.push({ name: 'RIGHT_TEMP_DURATION', side: 'right', value: String(seconds) });
    }
  }

  // Alarm handling is NOT subject to away-mode mirroring upstream — it only ever touches
  // `side` for the *state* update, and calls `executeFunction('ALARM_CLEAR', 'empty')` with
  // no side argument at all (never a per-side command name) when the value is falsy; the
  // state is forced to false either way (`updateDeviceStatus.ts`: "Can only set
  // isAlarmVibrating to false for now").
  if (isAlarmVibrating !== undefined) {
    if (!isAlarmVibrating) {
      commands.push({ name: 'ALARM_CLEAR', value: 'empty' });
    }
    state.deviceStatus[side].isAlarmVibrating = false;
  }
}

function applyDeviceStatusPatch(
  state: MockPodState,
  patch: DeviceStatusPatch,
  commands: Command[],
): void {
  // Truthiness guard copied verbatim from `updateDeviceStatus.ts`'s own
  // `if (deviceStatus.isPriming) await executeFunction('PRIME')` — there is no `else` branch and
  // no stop command, so `{isPriming: false}` is a proven no-op with respect to priming
  // (`hub-accessory`'s design.md Context; pod-test-double spec's "no-op-when-false" requirement).
  if (patch.isPriming) {
    commands.push({ name: 'PRIME' });
  }
  if (patch.left) {
    updateSide(state, 'left', patch.left, commands);
  }
  if (patch.right) {
    updateSide(state, 'right', patch.right, commands);
  }
  if (patch.settings) {
    Object.assign(state.deviceStatus.settings, patch.settings);
    commands.push({ name: 'SET_SETTINGS', value: JSON.stringify(patch.settings) });
  }
}

/**
 * `POST /api/alarm` (`hub-accessory`, pod-test-double spec's "mock reproduces the alarm-trigger
 * endpoint's override and non-idempotent behavior"). Reproduces `executeAlarm`'s own override
 * check (`server/src/jobs/alarmScheduler.ts`): silently no-ops when the addressed side is off or
 * away, *unless* `force` is set — the mock always records the raw HTTP request (handled by the
 * generic `record()` call in `handleRequest`, unrelated to this function), but only pushes the
 * hardware command when the trigger is actually allowed to reach the side.
 */
function applyAlarmRequest(state: MockPodState, request: AlarmRequest, commands: Command[]): void {
  const sideStatus = state.deviceStatus[request.side];
  const sideSettings = state.settings[request.side];
  const isOn = sideStatus.secondsRemaining > 0;
  const allowed = request.force || (isOn && !sideSettings.awayMode);
  if (!allowed) return;
  commands.push({
    name: request.side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT',
    side: request.side,
    value: String(request.vibrationIntensity),
  });
}

// ---------------------------------------------------------------------------------------
// Vitals query filtering (occupancy change, #19) — mirrors the real endpoint's Prisma
// `vitalsWhereInput` (`server/src/routes/metrics/vitals.ts`, design.md's Context): `side` is an
// exact string match when given, `startTime`/`endTime` bound `timestamp` inclusively when
// given, sorted ascending by timestamp. No filter at all returns every seeded row for both
// sides, in seed order (upstream orders by `timestamp asc`; the mock does the same rather than
// preserving the fixture's own on-disk order, matching what a real query would return).
// ---------------------------------------------------------------------------------------

function filterVitals(rows: VitalsResponse, query: URLSearchParams): VitalsResponse {
  const side = query.get('side');
  const startTime = query.get('startTime');
  const endTime = query.get('endTime');
  const startMs = startTime !== null ? Date.parse(startTime) : undefined;
  const endMs = endTime !== null ? Date.parse(endTime) : undefined;

  return rows
    .filter((row) => side === null || row.side === side)
    .filter((row) => startMs === undefined || Date.parse(row.timestamp) >= startMs)
    .filter((row) => endMs === undefined || Date.parse(row.timestamp) <= endMs)
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

// ---------------------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Every `"METHOD /path"` this mock actually routes — see the `switch` in `handleRequest`. */
const KNOWN_ENDPOINTS = new Set([
  'GET /api/deviceStatus',
  'GET /api/settings',
  'GET /api/schedules',
  'GET /api/services',
  'GET /api/serverStatus',
  'GET /api/metrics/presence',
  'GET /api/metrics/vitals',
  'POST /api/deviceStatus',
  'POST /api/settings',
  'POST /api/alarm',
]);

export async function startMockPod(options: StartMockPodOptions = {}): Promise<MockPod> {
  const requests: RecordedRequest[] = [];
  const commands: Command[] = [];
  const faults = new Map<string, { kind: FaultKind; status?: number | undefined; remaining: number }>();

  const initialSnapshot = buildInitialState(options.state);
  const state: MockPodState = structuredClone(initialSnapshot);

  function record(entry: RecordedRequest): void {
    requests.push(entry);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    const endpointKey = `${method} ${pathname}`;

    const activeFault = faults.get(endpointKey);
    if (activeFault) {
      const remaining = activeFault.remaining - 1;
      if (remaining <= 0) {
        faults.delete(endpointKey);
      } else {
        faults.set(endpointKey, { ...activeFault, remaining });
      }

      if (activeFault.kind === 'status') {
        const raw = await readBody(req);
        const body = parseJsonBody(raw);
        const status = activeFault.status ?? 500;
        record({ method, path: pathname, headers: req.headers, body, status, at: Date.now() });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Injected fault' }));
        return;
      }

      if (activeFault.kind === 'reset') {
        const raw = await readBody(req);
        const body = parseJsonBody(raw);
        record({ method, path: pathname, headers: req.headers, body, status: 0, at: Date.now() });
        req.socket.destroy();
        return;
      }

      if (activeFault.kind === 'hangMidBody') {
        // Headers (and a deliberately unterminated partial body chunk) go out, then the
        // response never ends — reproducing a timeout that fires *after* `fetch()`'s promise
        // has already resolved with a `Response`, mid-`response.text()`. See B2 in the
        // pod-client code review: this is the case a try/catch around only the `fetch()` call
        // (and not the body read too) fails to map to `PodTimeoutError`.
        await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"left":{"currentTemperatureLevel":0'); // unterminated JSON on purpose
        res.on('close', () => {
          record({
            method,
            path: pathname,
            headers: req.headers,
            body: undefined,
            status: 0,
            at: Date.now(),
          });
        });
        return;
      }

      // 'hang': accept the connection, consume the body, and never respond. The client's
      // own timeout is what ends this — see docs/POD-API.md and design.md's client timeout.
      await readBody(req);
      res.on('close', () => {
        record({
          method,
          path: pathname,
          headers: req.headers,
          body: undefined,
          status: 0,
          at: Date.now(),
        });
      });
      return;
    }

    const raw = await readBody(req);
    const body = method === 'GET' ? undefined : parseJsonBody(raw);

    let status = 200;
    let responseBody: unknown;
    let noContent = false;

    switch (endpointKey) {
      case 'GET /api/deviceStatus':
        responseBody = serializeDeviceStatus(state.deviceStatus);
        break;

      case 'GET /api/settings':
        responseBody = state.settings;
        break;

      case 'GET /api/schedules':
        responseBody = state.schedules;
        break;

      case 'GET /api/services':
        responseBody = state.services;
        break;

      case 'GET /api/serverStatus':
        responseBody = state.serverStatus;
        break;

      case 'GET /api/metrics/presence':
        responseBody = state.presence;
        break;

      case 'GET /api/metrics/vitals':
        responseBody = filterVitals(state.vitals, url.searchParams);
        break;

      case 'POST /api/deviceStatus': {
        // Validate against the full upstream contract (every DeviceStatusSchema field,
        // deep-partial, strict) — not PodClient's own narrower outgoing schema. See
        // UpstreamDeviceStatusPatchSchema's doc comment in types.ts (S3 in the pod-client
        // code review): the mock models the real Pod, which structurally accepts fields the
        // client never happens to send.
        const result = UpstreamDeviceStatusPatchSchema.safeParse(body);
        if (!result.success) {
          status = 400;
          responseBody = { error: 'Invalid request data', details: result.error.issues };
          break;
        }
        // `applyDeviceStatusPatch` only branches on the fields it has write semantics for
        // (design.md, "Mock shape and the command log") — matching upstream's own
        // `updateDeviceStatus.ts`, which likewise destructures only a subset of the fields
        // its own validation schema accepts. `result.data`'s wider shape is structurally
        // assignable to `DeviceStatusPatch`.
        applyDeviceStatusPatch(state, result.data, commands);
        status = 204;
        noContent = true;
        break;
      }

      case 'POST /api/settings': {
        const result = SettingsPatchSchema.safeParse(body);
        if (!result.success) {
          status = 400;
          responseBody = { error: 'Invalid request data', details: result.error.issues };
          break;
        }
        // Never allow the caller to overwrite the stored id — mirrors settings.ts's
        // `delete body.id` before merging.
        const patch: Record<string, unknown> = { ...result.data };
        delete patch.id;
        state.settings = deepMergeInto(
          state.settings as unknown as Record<string, unknown>,
          patch,
        ) as unknown as Settings;
        status = 200;
        // The *request* body has its `id` deleted above (mirrors settings.ts's own
        // `delete body.id` before merging), but the *response* is `res.json(settingsDB.data)`
        // — the stored document, id intact (settings.ts). Only the request-side delete
        // happens; the response is never stripped.
        responseBody = state.settings;
        break;
      }

      case 'POST /api/alarm': {
        const result = AlarmRequestSchema.safeParse(body);
        if (!result.success) {
          status = 400;
          responseBody = { error: 'Invalid request data', details: result.error.issues };
          break;
        }
        // Recorded as a command only when actually allowed to reach the side (see
        // `applyAlarmRequest`'s doc); the raw HTTP request itself is always recorded below,
        // regardless of outcome — matching upstream's own route, which responds `200` before
        // `executeAlarm`'s promise even settles (design.md's Context).
        applyAlarmRequest(state, result.data, commands);
        status = 200;
        // Matches `server/src/routes/alarm/alarm.ts`'s own response shape.
        responseBody = state.schedules;
        break;
      }

      default:
        status = 404;
        responseBody = { error: 'Not Found' };
    }

    record({ method, path: pathname, headers: req.headers, body, status, at: Date.now() });

    if (noContent) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      // A handler failure (e.g. the client aborted mid-read) should drop the connection
      // rather than crash the mock's test process.
      req.socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock Pod failed to bind a port');
  }
  const url = `http://127.0.0.1:${(address as AddressInfo).port}`;

  function fault(endpoint: string, faultOptions: FaultOptions): void {
    if (!KNOWN_ENDPOINTS.has(endpoint)) {
      throw new Error(
        `pod.fault(${JSON.stringify(endpoint)}, …): not a known "METHOD /path" endpoint — ` +
          `expected one of ${[...KNOWN_ENDPOINTS].join(', ')}. A typo'd fault target silently ` +
          'never fires, which is worse than a loud failure here.',
      );
    }
    faults.set(endpoint, {
      kind: faultOptions.kind,
      status: faultOptions.status,
      remaining: faultOptions.times,
    });
  }

  function setAlarmVibrating(side: Side, value: boolean): void {
    state.deviceStatus[side].isAlarmVibrating = value;
  }

  function reset(): void {
    const fresh = structuredClone(initialSnapshot);
    state.deviceStatus = fresh.deviceStatus;
    state.settings = fresh.settings;
    state.schedules = fresh.schedules;
    state.services = fresh.services;
    state.serverStatus = fresh.serverStatus;
    state.presence = fresh.presence;
    state.vitals = fresh.vitals;
    requests.length = 0;
    commands.length = 0;
    faults.clear();
  }

  function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  return { url, state, requests, commands, fault, setAlarmVibrating, reset, close };
}
