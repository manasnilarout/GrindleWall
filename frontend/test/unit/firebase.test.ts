import { describe, expect, it } from 'vitest';
import { firebaseAppName, firebaseMessage } from '../../src/lib/firebase';

describe('firebaseMessage', () => {
  it.each([
    ['auth/popup-closed-by-user', /cancelled/],
    ['auth/cancelled-popup-request', /cancelled/],
    ['auth/popup-blocked', /blocked the Google sign-in popup/],
    ['auth/unauthorized-domain', /not an authorized domain/],
    ['auth/network-request-failed', /Could not reach Google/],
  ])('%s reads as a sentence', (code, pattern) => {
    expect(firebaseMessage({ code, message: `Firebase: Error (${code}).` })).toMatch(pattern);
  });

  it('falls back to the message, then to a generic line', () => {
    expect(firebaseMessage(new Error('boom'))).toBe('boom');
    expect(firebaseMessage(undefined)).toBe('Google sign-in failed.');
  });
});

describe('firebaseAppName', () => {
  // Google's auth handler splits `${apiKey}:${appName}` on ":" to find the iframe
  // the popup result goes to; a colon in the name loses the result.
  it.each(['magickvoice-prd', 'a:b', 'gw'])('never contains a colon (project %s)', (projectId) => {
    expect(firebaseAppName(projectId)).not.toContain(':');
  });

  it('survives the handler\'s split: part [1] of apiKey:appName is the whole name', () => {
    const name = firebaseAppName('magickvoice-prd');
    expect(`AIzaKey:${name}`.split(':')[1]).toBe(name);
  });
});
