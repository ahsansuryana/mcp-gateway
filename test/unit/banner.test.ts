// ADR 0013: what the startup banner prints, asserted without touching a socket.
//
// No network here (PLAN.md D15). The interface list is injected, so these results do not
// depend on the machine's NICs -- the same test has to pass on a laptop, on the Linux CI
// runner, and on the Docker host.

import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

import { collectEndpoints, isLoopbackHost, renderBanner } from '../../src/server/banner.js';

interface Iface {
  address: string;
  family: 'IPv4' | 'IPv6' | 4 | 6;
  internal?: boolean;
}

function ifaces(list: Record<string, Iface[]>): Record<string, NetworkInterfaceInfo[]> {
  return Object.fromEntries(
    Object.entries(list).map(([name, addrs]) => [
      name,
      addrs.map((a) => ({
        address: a.address,
        family: a.family,
        internal: a.internal === true,
      })) as NetworkInterfaceInfo[],
    ]),
  );
}

const MIXED = ifaces({
  'Loopback Pseudo-Interface 1': [
    { address: '::1', family: 'IPv6', internal: true },
    { address: '127.0.0.1', family: 'IPv4', internal: true },
  ],
  Ethernet: [{ address: '192.168.1.7', family: 'IPv4' }],
  Tailscale: [{ address: '100.80.147.14', family: 'IPv4' }],
  'Ethernet 2': [{ address: '192.168.56.1', family: 'IPv4' }],
});

describe('ADR 0013 collectEndpoints', () => {
  it('never prints a wildcard bind as a callable URL', () => {
    // `http://0.0.0.0:3000/mcp` looks correct and cannot be connected to. This is the
    // regression most likely to slip in, and least likely to be noticed by eye.
    for (const host of ['0.0.0.0', '::']) {
      const endpoints = collectEndpoints({ host, port: 3000, interfaces: MIXED });
      expect(endpoints[0]?.url).toBe('http://localhost:3000/mcp');
      expect(endpoints.map((e) => e.url)).not.toContain(`http://${host}:3000/mcp`);
      expect(endpoints.some((e) => e.url.includes('0.0.0.0'))).toBe(false);
      expect(endpoints.some((e) => e.url.includes('[::]:3000'))).toBe(false);
    }
  });

  it('prints a specific bind host as itself', () => {
    const endpoints = collectEndpoints({ host: '127.0.0.1', port: 3000, interfaces: MIXED });
    expect(endpoints[0]?.url).toBe('http://127.0.0.1:3000/mcp');
  });

  it('excludes loopback from the network list', () => {
    const endpoints = collectEndpoints({ host: '0.0.0.0', port: 3000, interfaces: MIXED });
    const network = endpoints.filter((e) => e.kind === 'network').map((e) => e.url);
    expect(network).not.toContain('http://127.0.0.1:3000/mcp');
    expect(network).not.toContain('http://[::1]:3000/mcp');
    // And loopback still appears exactly once, as `local`.
    expect(endpoints.filter((e) => e.kind === 'local')).toHaveLength(1);
  });

  it('lists no IPv6 address for a 0.0.0.0 bind, because that listener cannot answer one', () => {
    // MEASURED, not assumed. With `--hostname 0.0.0.0` the first version of this banner
    // printed `http://[fd7a:115c:a1e0::583b:930f]:3888/mcp`; curl answered HTTP 000 while all
    // three IPv4 URLs on the same banner answered 200. `net.Server.listen(port, '0.0.0.0')`
    // reaches bind(2) as AF_INET, so the listener accepts no IPv6 at all. A banner full of
    // dead URLs is worse than a shorter banner.
    const endpoints = collectEndpoints({
      host: '0.0.0.0',
      port: 3888,
      interfaces: ifaces({
        Tailscale: [
          { address: '100.80.147.14', family: 'IPv4' },
          { address: 'fd7a:115c:a1e0::583b:930f', family: 'IPv6' },
        ],
      }),
    });
    const urls = endpoints.map((e) => e.url);
    expect(urls).toContain('http://100.80.147.14:3888/mcp');
    expect(urls.some((u) => u.includes('fd7a'))).toBe(false);
  });

  it('does list IPv6 for an :: bind, which is dual-stack', () => {
    const endpoints = collectEndpoints({
      host: '::',
      port: 3888,
      interfaces: ifaces({
        Tailscale: [
          { address: '100.80.147.14', family: 'IPv4' },
          { address: 'fd7a:115c:a1e0::583b:930f', family: 'IPv6' },
        ],
      }),
    });
    const urls = endpoints.map((e) => e.url);
    expect(urls).toContain('http://100.80.147.14:3888/mcp');
    expect(urls).toContain('http://[fd7a:115c:a1e0::583b:930f]:3888/mcp');
  });

  it('brackets IPv6 literals', () => {
    // `http://fe80::1:3000/mcp` is not a URL: curl reads the first colon as the port.
    const endpoints = collectEndpoints({
      host: '::',
      port: 3000,
      interfaces: ifaces({ v6: [{ address: '2001:db8::1', family: 'IPv6' }] }),
    });
    expect(endpoints.map((e) => e.url)).toContain('http://[2001:db8::1]:3000/mcp');
  });

  it('drops link-local and scoped IPv6', () => {
    // Neither is usable from a URL: a scoped address needs its %interface suffix and a
    // link-local address is never the one a remote client uses. Host is `::` so that this
    // exercises the link-local filter rather than the 0.0.0.0-is-IPv4-only rule.
    const endpoints = collectEndpoints({
      host: '::',
      port: 3000,
      interfaces: ifaces({
        eth0: [
          { address: 'fe80::1', family: 'IPv6' },
          { address: 'fe80::1%3', family: 'IPv6' },
          { address: '2001:db8::5', family: 'IPv6' },
        ],
      }),
    });
    const urls = endpoints.map((e) => e.url);
    expect(urls.some((u) => u.includes('fe80'))).toBe(false);
    expect(urls.some((u) => u.includes('%'))).toBe(false);
    expect(urls).toContain('http://[2001:db8::5]:3000/mcp');
  });

  it('deduplicates an address reported by two interfaces', () => {
    // A VPN and the physical NIC routinely report the same address.
    const endpoints = collectEndpoints({
      host: '0.0.0.0',
      port: 3000,
      interfaces: ifaces({
        Ethernet: [{ address: '192.168.1.7', family: 'IPv4' }],
        VPN: [{ address: '192.168.1.7', family: 'IPv4' }],
      }),
    });
    expect(endpoints.filter((e) => e.url === 'http://192.168.1.7:3000/mcp')).toHaveLength(1);
  });

  it('accepts both string and numeric family values', () => {
    // `family` is 'IPv4' on current Node and 4 on older ones. Both still occur.
    const endpoints = collectEndpoints({
      host: '0.0.0.0',
      port: 3000,
      interfaces: ifaces({
        eth0: [{ address: '10.0.0.5', family: 'IPv4' }],
        eth1: [{ address: '10.0.0.6', family: 4 }],
      }),
    });
    const urls = endpoints.map((e) => e.url);
    expect(urls).toContain('http://10.0.0.5:3000/mcp');
    expect(urls).toContain('http://10.0.0.6:3000/mcp');
  });

  it('sorts network addresses deterministically', () => {
    // os.networkInterfaces() ordering is not stable across boots. Without sorting the
    // banner would reorder itself on every restart.
    const forward = ifaces({
      Ethernet: [{ address: '192.168.1.7', family: 'IPv4' }],
      VPN: [{ address: '100.80.147.14', family: 'IPv4' }],
      Alt: [{ address: '192.168.56.1', family: 'IPv4' }],
    });
    const a = collectEndpoints({ host: '0.0.0.0', port: 3000, interfaces: forward });
    const b = collectEndpoints({
      host: '0.0.0.0',
      port: 3000,
      interfaces: ifaces({
        Alt: [{ address: '192.168.56.1', family: 'IPv4' }],
        VPN: [{ address: '100.80.147.14', family: 'IPv4' }],
        Ethernet: [{ address: '192.168.1.7', family: 'IPv4' }],
      }),
    });
    expect(a).toEqual(b);
    expect(a.filter((e) => e.kind === 'network').map((e) => e.url)).toEqual([
      'http://100.80.147.14:3000/mcp',
      'http://192.168.1.7:3000/mcp',
      'http://192.168.56.1:3000/mcp',
    ]);
  });

  it('labels each network address with its interface', () => {
    const endpoints = collectEndpoints({ host: '0.0.0.0', port: 3000, interfaces: MIXED });
    expect(endpoints.find((e) => e.url.includes('100.80.147.14'))?.iface).toBe('Tailscale');
    expect(endpoints.find((e) => e.url.includes('192.168.1.7'))?.iface).toBe('Ethernet');
  });

  it('lists no network addresses when bound to one specific address', () => {
    // A gateway on 127.0.0.1 can only be reached at 127.0.0.1. Suggesting 192.168.1.7
    // would be a URL that does not answer.
    const endpoints = collectEndpoints({ host: '127.0.0.1', port: 3000, interfaces: MIXED });
    expect(endpoints.filter((e) => e.kind === 'network')).toHaveLength(0);
  });

  it('lists network addresses when bound to a wildcard', () => {
    const endpoints = collectEndpoints({ host: '0.0.0.0', port: 3000, interfaces: MIXED });
    expect(endpoints.filter((e) => e.kind === 'network').length).toBeGreaterThan(1);
  });

  it('adds publicUrl as its own kind, appended to /mcp', () => {
    const endpoints = collectEndpoints({
      host: '0.0.0.0',
      port: 3000,
      publicUrl: 'https://tunnel.example',
      interfaces: MIXED,
    });
    const last = endpoints.at(-1);
    expect(last?.kind).toBe('public');
    // Claude's connector requires `resource` to equal the entered URL including its path,
    // so the banner must show exactly what belongs in the connector dialog.
    expect(last?.url).toBe('https://tunnel.example/mcp');
  });

  it('does not repeat publicUrl when it resolves to a listed address', () => {
    const endpoints = collectEndpoints({
      host: '0.0.0.0',
      port: 3000,
      publicUrl: 'http://192.168.1.7:3000',
      interfaces: MIXED,
    });
    expect(endpoints.filter((e) => e.kind === 'public')).toHaveLength(0);
  });

  it('ignores a publicUrl that is not a URL rather than printing it', () => {
    // loadConfig has not run yet when the banner renders, so a malformed value from the
    // config file can still reach here.
    const endpoints = collectEndpoints({
      host: '0.0.0.0',
      port: 3000,
      publicUrl: 'tunnel.example',
      interfaces: MIXED,
    });
    expect(endpoints.some((e) => e.url.includes('tunnel.example'))).toBe(false);
  });
});

describe('ADR 0013 renderBanner', () => {
  const base = {
    host: '0.0.0.0',
    port: 3000,
    interfaces: MIXED,
    upstreamCount: 2,
    protectedGateway: true,
    configPath: '/home/u/.mcp-gateway/gateway.json',
    configCreated: false,
  };

  it('shows every reachable URL', () => {
    const text = renderBanner(base);
    expect(text).toContain('http://localhost:3000/mcp');
    expect(text).toContain('http://192.168.1.7:3000/mcp');
    expect(text).toContain('http://100.80.147.14:3000/mcp');
    expect(text).toContain('Tailscale');
  });

  it('uses the port it is given, not one it reads from anywhere', () => {
    // The listener may have taken a different port than the config named. The banner is
    // handed the bound port precisely so this cannot drift.
    const text = renderBanner({ ...base, port: 45678 });
    expect(text).toContain('http://localhost:45678/mcp');
    expect(text).not.toContain(':3000/');
  });

  it('marks an unauthenticated gateway on every line that matters', () => {
    // Bound to loopback, because that is the only bind an unauthenticated gateway may use.
    const text = renderBanner({ ...base, host: '127.0.0.1', protectedGateway: false });
    expect(text).toContain('auth       NONE');
    expect(text).toContain('accepts any caller');
    // And it explains why it was allowed, so it does not read as an oversight.
    expect(text).toContain('bound to loopback');
  });

  it('states the refusal rule alongside the warning', () => {
    const text = renderBanner({ ...base, host: '127.0.0.1', protectedGateway: false });
    expect(text).toContain('0.0.0.0 or a LAN address this combination is refused');
  });

  it('does not claim loopback on a non-loopback host, even in open mode', () => {
    // Unreachable in practice -- startGateway refuses this combination before binding -- but
    // the banner must stay truthful if it is ever rendered, and must not assert a reason it
    // does not have.
    const text = renderBanner({ ...base, host: '0.0.0.0', protectedGateway: false });
    expect(text).toContain('accepts any caller');
    expect(text).not.toContain('bound to loopback');
  });

  it('says nothing alarming when the gateway IS protected', () => {
    const text = renderBanner({ ...base, protectedGateway: true });
    expect(text).toContain('auth       bearer');
    expect(text).not.toContain('accepts any caller');
  });

  it('marks a config this run created', () => {
    expect(renderBanner({ ...base, configCreated: true })).toContain('just created');
    expect(renderBanner({ ...base, configCreated: false })).not.toContain('just created');
  });

  it('nudges when there are no upstreams yet', () => {
    expect(renderBanner({ ...base, upstreamCount: 0 })).toContain('none yet');
    expect(renderBanner({ ...base, upstreamCount: 1 })).not.toContain('none yet');
  });

  it('shows a generated key once, with instructions', () => {
    const text = renderBanner({ ...base, generatedKey: 'GENERATED-KEY-VALUE' });
    expect(text).toContain('GENERATED-KEY-VALUE');
    expect(text).toContain('not shown again');
    expect(text).toContain('Authorization: Bearer');
  });

  it('omits the key section entirely when no key was generated', () => {
    const text = renderBanner(base);
    expect(text).not.toContain('API KEY');
    expect(text).not.toContain('Authorization: Bearer');
  });
});

describe('ADR 0013 isLoopbackHost', () => {
  it('recognises the loopback forms, with or without IPv6 brackets', () => {
    // `URL.hostname` yields [::1] on one path and ::1 on another, so both spellings have to
    // resolve the same way or the open-mode guard could be bypassed by a bracketed config.
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });

  it('rejects the wildcard and the LAN addresses', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.7')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});