import { describe, it, expect, vi } from 'vitest';

describe('buildEmailActionUrl', () => {
  it('uses EMAIL_ACTION_PUBLIC_URL without duplicating /email-actions', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://user@localhost/testdb';
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.EMAIL_ACTION_PUBLIC_URL = 'http://dt-internalproxy-1.etl.co.ls/flowdesk/uat';

    const { buildEmailActionUrl } = await import('../src/lib/emailActionTokens');
    const token = 'token/with/slash';
    const url = buildEmailActionUrl(token);
    expect(url).toBe(`http://dt-internalproxy-1.etl.co.ls/flowdesk/uat/email-actions/${encodeURIComponent(token)}`);
  });

  it('handles base already containing /email-actions', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://user@localhost/testdb';
    process.env.JWT_SECRET = 'b'.repeat(32);
    process.env.EMAIL_ACTION_PUBLIC_URL = 'http://dt-internalproxy-1.etl.co.ls/flowdesk/uat/email-actions';

    const { buildEmailActionUrl } = await import('../src/lib/emailActionTokens');
    const token = 'tok';
    const url = buildEmailActionUrl(token);
    expect(url).toBe(`http://dt-internalproxy-1.etl.co.ls/flowdesk/uat/email-actions/${encodeURIComponent(token)}`);
  });

  it('falls back to APP_URL when EMAIL_ACTION_PUBLIC_URL unset', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://user@localhost/testdb';
    process.env.JWT_SECRET = 'c'.repeat(32);
    // simulate unset by setting empty string so zod treats it as falsy
    process.env.EMAIL_ACTION_PUBLIC_URL = '';
    process.env.APP_URL = 'http://app.local';

    const { buildEmailActionUrl } = await import('../src/lib/emailActionTokens');
    const token = 'tok2';
    const url = buildEmailActionUrl(token);
    expect(url).toBe(`http://app.local/?email_action=${encodeURIComponent(token)}`);
  });
});
