import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // poller-and-write-queue (openspec/changes/poller-and-write-queue/tasks.md, 1.3): every
    // timing decision in these modules must flow through the injected `TimerApi`, never
    // a global, or fake-timer tests can't make jitter and the clock deterministic (design.md,
    // "Timer, clock and randomness injection"). `globalThis.setTimeout` etc. are still the
    // escape hatch the default `TimerApi` implementation itself needs — this rule only
    // forbids the bare identifiers. `src/pod/keepAlive.ts` joined this set at `keep-alive`
    // (tasks.md 2.5) — same discipline, same injected-timer pattern.
    files: ['src/pod/snapshot.ts', 'src/pod/poller.ts', 'src/pod/writeQueue.ts', 'src/pod/keepAlive.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Use the injected TimerApi instead of the global setTimeout.' },
        { name: 'setInterval', message: 'Use the injected TimerApi instead of the global setInterval.' },
        { name: 'clearTimeout', message: 'Use the injected TimerApi instead of the global clearTimeout.' },
        { name: 'clearInterval', message: 'Use the injected TimerApi instead of the global clearInterval.' },
        { name: 'Date', message: 'Use the injected TimerApi.now() instead of the global Date.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the injected TimerApi.random() instead of Math.random().' },
      ],
    },
  },
);
