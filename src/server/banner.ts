// ADR 0013: the startup banner -- the list of URLs a client can actually reach.
//
// Two audiences share stdout, so it must not share a format with the JSON logs (which moved
// to stderr in 2b14768). The banner is for a person looking at a terminal; the logs are for
// something parsing them.
//
// `collectEndpoints` is the ONLY function in this repository that touches
// os.networkInterfaces(), and it takes the interface list as an argument so tests never
// depend on the machine's interfaces. That is why this file has no clock, no process and no
// filesystem: `renderBanner` is pure, string in, string out.

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type EndpointKind = 'local' | 'network' | 'public';

export interface Endpoint {
  kind: EndpointKind;
  /** Rendered form. IPv6 hosts are bracketed, because a bare one is not a valid URL. */
  url: string;
  /** The interface that reported the address. Empty for loopback and publicUrl. */
  iface?: string;
}

export interface BannerInput {
  /** The effective bind host, AFTER flag overrides. */
  host: string;
  /**
   * The port the listener ACTUALLY bound -- `server.address().port`, not
   * config.gateway.port. They differ whenever the configured port is taken or when the
   * config was changed by a flag, and a banner that disagrees with the listener is worse
   * than no banner.
   */
  port: number;
  publicUrl?: string;
  /** Injected; defaults to os.networkInterfaces(). */
  interfaces?: Readonly<Record<string, NetworkInterfaceInfo[] | undefined>>;
  upstreamCount: number;
  /** False when the gateway accepts any caller. Drives the loudest warning we have. */
  protectedGateway: boolean;
  /** Absolute path of the config that was resolved, or created. */
  configPath: string;
  /** Set when this run created the file, so the banner can say so. */
  configCreated: boolean;
  /** Printed once, to the owner. Never re-read, never logged, never persisted here. */
  generatedKey?: string;
}

/** Loopback binds, the only ones an unauthenticated gateway may use (ADR 0013). */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** `0.0.0.0` and `::` are bind addresses, not names anything can connect back to. */
function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/**
 * Renders a host into a URL authority.
 *
 * IPv6 literals keep their brackets in a URL. `http://fe80::1:3000/mcp` is not a URL --
 * curl reads the first colon as the port separator and fails. The same reasoning already
 * appears in schema.ts LOCAL_HOSTS, which lists `::1` twice because `URL.hostname` yields
 * it bracketed in one path and bare in another.
 */
function authority(host: string, port: number): string {
  const needsBrackets = host.includes(':') && !(host.startsWith('[') && host.endsWith(']'));
  return `${needsBrackets ? `[${host}]` : host}:${port}`;
}

interface Candidate {
  address: string;
  family: string;
  internal: boolean;
  iface: string;
}

function toCandidates(
  ifaces: Readonly<Record<string, NetworkInterfaceInfo[] | undefined>>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [iface, addresses] of Object.entries(ifaces)) {
    for (const info of addresses ?? []) {
      // `family` is the string 'IPv4'/'IPv6' on current Node and the number 4/6 on older
      // ones. Both still turn up in the wild, so both are accepted rather than one being
      // assumed. Read as `unknown` because the current @types/node declares only the string
      // form, and comparing that union against a number narrows to `never` -- which would
      // make the branch look unreachable to the compiler and to the next reader.
      const raw: unknown = info.family;
      const family = typeof raw === 'number' ? `IPv${raw}` : String(raw);
      out.push({
        address: info.address,
        family,
        internal: info.internal === true,
        iface,
      });
    }
  }
  return out;
}

/**
 * Builds the ordered endpoint list.
 *
 * Order is local, then network sorted by address, then public. Sorting is not cosmetic:
 * os.networkInterfaces() returns keys in an order that varies between platforms and boots,
 * so an unsorted list would make the banner different on every restart and impossible to
 * read as a diff.
 */
export function collectEndpoints(input: {
  host: string;
  port: number;
  publicUrl?: string;
  interfaces?: Readonly<Record<string, NetworkInterfaceInfo[] | undefined>>;
}): Endpoint[] {
  const { host, port } = input;
  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();

  // A wildcard bind is never printed as a URL. `http://0.0.0.0:3000/mcp` looks plausible and
  // is not callable; `localhost` is. OAuthService already makes the same substitution for
  // the upstream callback URL, and having the two disagree would be worse than either.
  const localHost = isWildcardHost(host) ? 'localhost' : host;
  const local = `http://${authority(localHost, port)}/mcp`;
  endpoints.push({ kind: 'local', url: local });
  seen.add(localHost);

  if (!isWildcardHost(host)) {
    // A gateway bound to one specific address can only be reached at that address. Listing
    // every interface would suggest URLs that are not listening.
    return withPublic(endpoints, input.publicUrl, seen);
  }

  const candidates = toCandidates(input.interfaces ?? networkInterfaces());
  // A `0.0.0.0` bind is IPv4-ONLY: Node passes it to bind(2) as AF_INET, so the listener
  // accepts not one IPv6 connection and every IPv6 URL printed for such a gateway is dead on
  // arrival. Measured, not assumed -- with `--hostname 0.0.0.0` the banner listed
  // `http://[fd7a:115c:a1e0::583b:930f]:3888/mcp` and curl answered HTTP 000, while all three
  // IPv4 URLs on the same banner answered 200. An `::` bind is dual-stack on every platform
  // this runs on, so IPv6 is listed there and only there.
  const ipv4Only = host === '0.0.0.0';
  const usable = candidates
    .filter((c) => c.internal === false)
    .filter((c) => c.family === 'IPv4' || c.family === 'IPv6')
    .filter((c) => !ipv4Only || c.family === 'IPv4')
    // Link-local needs a scope id to be usable at all (`fe80::1%eth0`), which no URL carries,
    // and it is never the address a remote client would use.
    .filter((c) => !isLinkLocal(c.address))
    // Sorted before de-duplicating, so which interface "wins" a duplicated address is
    // decided by the address rather than by platform iteration order.
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  for (const candidate of usable) {
    // Two interfaces (a VPN and the physical NIC, say) routinely report the same address.
    // Checked HERE, not in a pre-filter above: a filter chain runs to completion before the
    // loop pushes anything, so `seen` would still be empty and both copies would pass. That
    // was the first version of this function, and its own test caught it.
    if (seen.has(candidate.address)) continue;
    seen.add(candidate.address);
    endpoints.push({
      kind: 'network',
      url: `http://${authority(candidate.address, port)}/mcp`,
      iface: candidate.iface,
    });
  }

  return withPublic(endpoints, input.publicUrl, seen);
}

function isLinkLocal(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith('fe80') || lower.includes('%');
}

function withPublic(
  endpoints: Endpoint[],
  publicUrl: string | undefined,
  seen: Set<string>,
): Endpoint[] {
  if (publicUrl === undefined || publicUrl.length === 0) return endpoints;
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    // The flag layer already rejects a non-URL, so reaching here means the value came from
    // the config file and loadConfig has not run yet. Printing nothing is better than
    // printing a string that is not a URL.
    return endpoints;
  }
  const mcpUrl = new URL('/mcp', parsed).href;
  // The public URL is what OAuth clients are told; if it happens to resolve to the same
  // authority as a LAN address, printing both would imply two servers.
  if (seen.has(parsed.hostname)) return endpoints;
  endpoints.push({ kind: 'public', url: mcpUrl });
  return endpoints;
}

const LABELS: Record<EndpointKind, string> = {
  local: 'Local  ',
  network: 'Network',
  public: 'Public ',
};

/** Renders the banner. Pure: no clock, no process, no filesystem, no randomness. */
export function renderBanner(input: BannerInput): string {
  const endpoints = collectEndpoints({
    host: input.host,
    port: input.port,
    ...(input.publicUrl === undefined ? {} : { publicUrl: input.publicUrl }),
    ...(input.interfaces === undefined ? {} : { interfaces: input.interfaces }),
  });

  const lines: string[] = [];
  lines.push('');
  for (const endpoint of endpoints) {
    const suffix = endpoint.iface === undefined ? '' : ` (${endpoint.iface})`;
    lines.push(`  >  ${LABELS[endpoint.kind]}:  ${endpoint.url}${suffix}`);
  }
  lines.push('');
  lines.push(`  config     ${input.configPath}${input.configCreated ? '  (just created)' : ''}`);
  lines.push(
    `  upstreams  ${input.upstreamCount}${input.upstreamCount === 0 ? '  (none yet — add one under "mcp")' : ''}`,
  );
  if (input.protectedGateway) {
    lines.push('  auth       bearer');
  } else {
    // The single most important line in the banner. An unauthenticated /mcp means anyone
    // who can reach the port can call every upstream tool.
    lines.push('  auth       NONE — POST /mcp accepts any caller on this machine');
    if (isLoopbackHost(input.host)) {
      lines.push('             allowed because the gateway is bound to loopback.');
      lines.push('             On 0.0.0.0 or a LAN address this combination is refused at startup.');
    }
  }
  if (input.generatedKey !== undefined) {
    // Printed ONCE, to the owner, at the moment it is generated. It is never written to
    // /status, never logged, and never shown again -- the same discipline every other secret
    // in this codebase follows.
    lines.push('');
    lines.push(`  API KEY    ${input.generatedKey}`);
    lines.push('             Store it now. It is not written to any file and not shown again.');
    lines.push('             Send it as:  Authorization: Bearer <key>');
  }
  lines.push('');
  return lines.join('\n');
}