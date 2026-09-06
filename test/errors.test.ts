import { describe, expect, it } from 'vitest';

import {
  PodAbortError,
  PodBadRequestError,
  PodError,
  PodHttpError,
  PodNetworkError,
  PodRequestError,
  PodResponseError,
  PodTimeoutError,
} from '../src/pod/errors.js';

const subclasses: Array<[string, () => PodError]> = [
  ['PodNetworkError', () => new PodNetworkError('network down')],
  ['PodTimeoutError', () => new PodTimeoutError('timed out')],
  ['PodBadRequestError', () => new PodBadRequestError('bad request', 400, { field: 'left' })],
  ['PodHttpError', () => new PodHttpError('server error', 503, 'oops')],
  ['PodResponseError', () => new PodResponseError('bad shape', 'left.isOn')],
  ['PodRequestError', () => new PodRequestError('conflicting fields')],
  ['PodAbortError', () => new PodAbortError('aborted')],
];

describe('PodError taxonomy', () => {
  it.each(subclasses)('%s is instanceof PodError and sets .name', (className, make) => {
    const error = make();
    expect(error).toBeInstanceOf(PodError);
    expect(error.name).toBe(className);
  });

  it('PodBadRequestError exposes status and details', () => {
    const error = new PodBadRequestError('bad request', 400, { field: 'left', reason: 'unknown key' });
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ field: 'left', reason: 'unknown key' });
  });

  it('PodHttpError exposes status and body', () => {
    const error = new PodHttpError('server error', 503, 'Service Unavailable');
    expect(error.status).toBe(503);
    expect(error.body).toBe('Service Unavailable');
  });

  it('PodResponseError exposes the offending property path', () => {
    const error = new PodResponseError('bad shape', 'left.isOn');
    expect(error.path).toBe('left.isOn');
  });

  it('survives serialisation into a log line (name and message present)', () => {
    const error = new PodTimeoutError('timed out after 8000ms');
    const logLine = `${error.name}: ${error.message}`;
    expect(logLine).toBe('PodTimeoutError: timed out after 8000ms');
  });
});
