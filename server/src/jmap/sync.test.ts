import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointLooksStale } from './sync.js';
import { JmapError } from './client.js';

test('an answer that is not a JMAP endpoint answering earns a session refetch', () => {
  // The cached apiUrl now points at a proxy with nothing behind it, at a name
  // that serves something else, or at a path that has moved.
  for (const status of [404, 405, 410, 421, 500, 502, 503, 504]) {
    assert.equal(endpointLooksStale(new JmapError('http', `JMAP request failed with HTTP ${status}`, status)), true, String(status));
  }
  // A redirect the API call refuses to follow, or a body that is not JSON,
  // arrives as a plain Error rather than a JmapError.
  assert.equal(endpointLooksStale(new TypeError('fetch failed')), true);
  assert.equal(endpointLooksStale(new SyntaxError('Unexpected token < in JSON at position 0')), true);
});

test('credential and method errors leave the cached endpoints alone', () => {
  // Wrong password: handled as auth_error, and the endpoints are fine.
  assert.equal(endpointLooksStale(new JmapError('unauthorized', 'Mail server rejected the credentials', 401)), false);
  // The server answered as a JMAP server should; the endpoints did their job.
  assert.equal(endpointLooksStale(new JmapError('cannotCalculateChanges', 'JMAP method error')), false);
  assert.equal(endpointLooksStale(new JmapError('http', 'JMAP request failed with HTTP 429', 429)), false);
  assert.equal(endpointLooksStale(new JmapError('http', 'JMAP request failed with HTTP 400', 400)), false);
});
