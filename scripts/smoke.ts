/**
 * Read-only smoke check against a real free-sleep Pod (or a mock one in tests).
 *
 * Usage: `npm run smoke -- <pod-host>[:<port>]`
 *
 * Reads `deviceStatus`, `settings`, `schedules`, and `services` through the real
 * `PodClient` — exercising its timeout and error paths against real hardware — and prints:
 * reachability, `coverVersion` / `hubVersion` / `freeSleep.version`, the raw `waterLevel`
 * string and `interpretWaterLevel`'s verdict, whether gesture tap counters were present,
 * `biometrics.enabled`, and per-request latency. Performs **no writes** of any kind
 * (proposal.md, "free-sleep API endpoints touched"): it cannot trigger the job rebuild that
 * `settingsDB.json` / `schedulesDB.json` writes cause, and it cannot disturb a bed someone is
 * sleeping in.
 *
 * Runs under `node --experimental-strip-types` (Node >= 22.6; unflagged from 22.18 / 24) — no
 * transpiler. This file and everything it imports (`src/pod/client.ts`, `src/pod/types.ts`,
 * `src/pod/errors.ts`) therefore avoid TypeScript syntax that needs transformation rather than
 * erasure: no `enum`, no `namespace`, no parameter properties. The fallback, if a future change
 * needs one of those, is `npx tsx scripts/smoke.ts` instead.
 */

// `.ts` extensions (not the usual NodeNext `.js`) so this file resolves under direct
// `node --experimental-strip-types` execution — see client.ts's header comment.
import { PodClient } from '../src/pod/client.ts';
import { interpretWaterLevel, type DeviceStatus } from '../src/pod/types.ts';
import { PodError } from '../src/pod/errors.ts';

function usage(): string {
  return 'Usage: npm run smoke -- <pod-host>[:<port>]\n  e.g. npm run smoke -- 192.168.1.42';
}

/** Splits `<host>` or `<host>:<port>` — the last colon wins, so a bare hostname is fine. */
function parseHostArg(arg: string): { host: string; port?: number } {
  const lastColon = arg.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: arg };
  }
  const host = arg.slice(0, lastColon);
  const port = Number(arg.slice(lastColon + 1));
  if (host.length === 0 || !Number.isInteger(port) || port <= 0) {
    return { host: arg };
  }
  return { host, port };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

function hasTapsField(deviceStatus: DeviceStatus): boolean {
  return 'taps' in deviceStatus.left || 'taps' in deviceStatus.right;
}

function describeAddress(host: string, port: number | undefined): string {
  return port === undefined ? host : `${host}:${port}`;
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  const { host, port } = parseHostArg(arg);
  const address = describeAddress(host, port);
  const client = port === undefined ? new PodClient({ host }) : new PodClient({ host, port });

  try {
    const deviceStatus = await timed(() => client.getDeviceStatus());
    const settings = await timed(() => client.getSettings());
    const schedules = await timed(() => client.getSchedules());
    const services = await timed(() => client.getServices());

    const { waterLevel } = deviceStatus.value;

    process.stdout.write(`Pod reachable at ${address}\n`);
    process.stdout.write(`  coverVersion:       ${deviceStatus.value.coverVersion}\n`);
    process.stdout.write(`  hubVersion:         ${deviceStatus.value.hubVersion}\n`);
    process.stdout.write(`  freeSleep.version:  ${deviceStatus.value.freeSleep.version}\n`);
    process.stdout.write(
      `  waterLevel:         "${waterLevel}" (${interpretWaterLevel(waterLevel)})\n`,
    );
    process.stdout.write(`  taps present:       ${hasTapsField(deviceStatus.value)}\n`);
    process.stdout.write(`  biometrics.enabled: ${services.value.biometrics.enabled}\n`);
    process.stdout.write('  latency:\n');
    process.stdout.write(`    GET /api/deviceStatus  ${deviceStatus.ms}ms\n`);
    process.stdout.write(`    GET /api/settings      ${settings.ms}ms\n`);
    process.stdout.write(`    GET /api/schedules     ${schedules.ms}ms\n`);
    process.stdout.write(`    GET /api/services      ${services.ms}ms\n`);
    return 0;
  } catch (error) {
    const typeName =
      error instanceof PodError
        ? error.name
        : error instanceof Error
          ? error.constructor.name
          : 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Smoke check failed against ${address}: ${typeName}: ${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
