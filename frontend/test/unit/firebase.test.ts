import { describe, expect, it } from 'vitest';
import { firebaseMessage } from '../../src/lib/firebase';

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
