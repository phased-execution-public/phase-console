import { describe, expect, it } from 'vitest';

import { BASE, MOUNTED, baseFor, consolePath } from './base';

describe('the page prefix', () => {
  it('is / at a console’s own origin, which is where the suite runs', () => {
    expect(BASE).toBe('/');
    expect(MOUNTED).toBe(false);
    expect(baseFor('/')).toBe('/');
    expect(baseFor('/index.html')).toBe('/');
  });

  it('is /c/<id>/ for a page served under a mount', () => {
    expect(baseFor('/c/f922d743-pe-hub/')).toBe('/c/f922d743-pe-hub/');
    expect(baseFor('/c/f922d743-pe-hub/index.html')).toBe('/c/f922d743-pe-hub/');
    // No trailing slash is not a mount the page can resolve against — the proxy redirects it.
    expect(baseFor('/c/f922d743-pe-hub')).toBe('/');
    expect(baseFor('/cc/x/')).toBe('/');
  });

  it('prefixes absolute console paths under a mount, and nothing else', () => {
    const base = '/c/abc12345-demo/';
    expect(consolePath('/api/state', base)).toBe('/c/abc12345-demo/api/state');
    expect(consolePath('/events', base)).toBe('/c/abc12345-demo/events');
    expect(consolePath('/ws/terminal?token=t', base)).toBe('/c/abc12345-demo/ws/terminal?token=t');
    expect(consolePath('//elsewhere.example/x', base)).toBe('//elsewhere.example/x');
    expect(consolePath('https://elsewhere.example/x', base)).toBe('https://elsewhere.example/x');
    expect(consolePath('api/state', base)).toBe('api/state');
  });

  it('changes nothing at a console’s own origin', () => {
    expect(consolePath('/api/state')).toBe('/api/state');
    expect(consolePath('/events', '/')).toBe('/events');
  });
});
