// ADR 0012: config resolution and the `.mcp-gateway` state directory.
//
// One small pure function decides everything, so the whole search order is testable without
// touching a real filesystem: the caller injects `exists`.
//
// verified: nodejs.org/api/path.html#pathresolvepaths-segments (path.resolve)
// verified: nodejs.org/api/os.html#oshomedir (os.homedir)

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Defined here rather than in load.ts so that load.ts can import from this module without
 * the two forming an import cycle. load.ts re-exports both names, so existing importers
 * (src/cli.ts) keep working.
 */
export const CONFIG_PATH_ENV_VAR = 'GATEWAY_CONFIG';
export const DEFAULT_CONFIG_FILENAME = 'gateway.json';

export const CONFIG_DIR_NAME = '.mcp-gateway';
export const HOME_DIR_ENV_VAR = 'GATEWAY_HOME';
export const CONFIG_FILENAME = 'gateway.json';

/** Where the resolved config came from. Used only to phrase messages, never to leak paths. */
export type ConfigSource = 'flag' | 'env' | 'project' | 'home' | 'legacy';

export interface ResolvedConfigPath {
  /** Absolute path to the config file. */
  path: string;
  source: ConfigSource;
  /**
   * True when the config was found at the pre-ADR-0012 location `./gateway.json`. The CLI
   * warns once, naming the new location, but keeps working: breaking a working deployment
   * over a file move is not a good trade.
   */
  legacy: boolean;
}

export interface ResolveInputs {
  /** The value of `-c` / `--config`, if the flag was given. */
  flag?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** Injected so tests do not depend on the machine's real home. */
  homedir: string;
  /** Existence predicate. Injected for the same reason. */
  exists: (absolutePath: string) => boolean;
}

export interface ResolveFailure {
  /** Every absolute path that was tried, in order. Printed so the error is actionable. */
  checked: string[];
}

/**
 * Builds the ordered list of candidate paths.
 *
 * Exported separately so tests can assert the ORDER without asserting which one wins.
 */
export function candidatePaths(inputs: Omit<ResolveInputs, 'exists'>): string[] {
  const { flag, env, cwd, homedir: home } = inputs;
  const paths: string[] = [];

  // 1. -c / --config. Kept out of the existence search on purpose: see resolveConfigLocation.
  if (flag !== undefined && flag.length > 0) paths.push(resolveAgainst(cwd, flag));

  // 2. GATEWAY_CONFIG.
  const fromEnv = env[CONFIG_PATH_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.length > 0) paths.push(resolveAgainst(cwd, fromEnv));

  // 3. Project-local.
  paths.push(join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME));

  // 4. GATEWAY_HOME, else the OS home directory.
  const gateHome = env[HOME_DIR_ENV_VAR];
  const homeRoot = gateHome !== undefined && gateHome.length > 0 ? gateHome : home;
  paths.push(join(homeRoot, CONFIG_DIR_NAME, CONFIG_FILENAME));

  // 5. Legacy cwd config.
  paths.push(join(cwd, CONFIG_FILENAME));

  return paths;
}

/**
 * `-c` is AUTHORITATIVE and is not existence-checked.
 *
 * Every other level falls through when the file is missing, which is what "first hit wins"
 * means for an ambient default. For an explicit flag that would be a trap: `-c /etc/x.json`
 * followed by the gateway quietly serving `./.mcp-gateway/gateway.json` is the kind of
 * surprise that runs the wrong upstream configuration in production. A missing `-c` target
 * is an error naming that exact path.
 */
export function resolveConfigLocation(inputs: ResolveInputs): ResolvedConfigPath | ResolveFailure {
  const { flag, exists } = inputs;

  if (flag !== undefined && flag.length > 0) {
    const path = resolveAgainst(inputs.cwd, flag);
    return { path, source: 'flag', legacy: false };
  }

  const { candidates, sources } = rankedCandidates(inputs);
  for (let i = 0; i < candidates.length; i += 1) {
    const path = candidates[i];
    if (path === undefined || !exists(path)) continue;
    const source = sources[i] ?? 'env';
    return { path, source, legacy: source === 'legacy' };
  }
  return { checked: candidates };
}

/**
 * Candidates paired with their source.
 *
 * The source is carried ALONGSIDE each path rather than recovered from its index: the
 * array's contents shift depending on whether a flag and an env var are present, so index
 * arithmetic silently labels the winning candidate with the wrong source the moment any of
 * those is absent.
 */
function rankedCandidates(inputs: Omit<ResolveInputs, 'exists'>): {
  candidates: string[];
  sources: ConfigSource[];
} {
  const { flag, env, cwd, homedir: home } = inputs;
  const candidates: string[] = [];
  const sources: ConfigSource[] = [];

  if (flag !== undefined && flag.length > 0) {
    candidates.push(resolveAgainst(cwd, flag));
    sources.push('flag');
  }

  const fromEnv = env[CONFIG_PATH_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    candidates.push(resolveAgainst(cwd, fromEnv));
    sources.push('env');
  }

  candidates.push(join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME));
  sources.push('project');

  const gateHome = env[HOME_DIR_ENV_VAR];
  const homeRootDir = gateHome !== undefined && gateHome.length > 0 ? gateHome : home;
  candidates.push(join(homeRootDir, CONFIG_DIR_NAME, CONFIG_FILENAME));
  sources.push('home');

  candidates.push(join(cwd, CONFIG_FILENAME));
  sources.push('legacy');

  return { candidates, sources };
}

/** A literal `~` is never expanded; see ADR 0012 D2. */
function resolveAgainst(cwd: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

/**
 * The home root the config directory lives under: `GATEWAY_HOME` when set, else `homedir()`.
 *
 * Exists so `init` and the resolution agree, and so Docker can relocate the entire state
 * directory by changing one variable.
 */
export function homeRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env[HOME_DIR_ENV_VAR];
  return configured !== undefined && configured.length > 0 ? configured : homedir();
}

/** Absolute path of the state directory for a given config path. */
export function configDirFor(configPath: string): string {
  return dirname(configPath);
}

/** Where the OAuth token store lives for a given config path. Unchanged rule, new parent. */
export function tokenStorePathFor(configPath: string): string {
  return join(configDirFor(configPath), 'data', 'tokens.enc.json');
}

/**
 * The pre-ADR-0012 store location: `<configDir>/../data/tokens.enc.json`.
 *
 * Only reachable when the config itself sat in the config's directory as `gateway.json`.
 * Kept so an existing store is never silently orphaned -- see ADR 0012 D3.
 */
export function legacyTokenStorePathFor(configPath: string): string {
  return join(configDirFor(configPath), '..', 'data', 'tokens.enc.json');
}