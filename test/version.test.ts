import { describe, expect, it } from 'vitest';
import { USER_AGENT, VERSION } from '../src/util/version.js';

describe('version', () => {
  it('builds an honest user agent', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(USER_AGENT).toBe(`polito-cal-sync/${VERSION} (personal, self-hosted)`);
  });
});
