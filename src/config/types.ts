export type ExposeMode = "full" | "lazy" | "auto";
export type BackendKind = "http" | "sse" | "stdio";

/** `auth` pada backend http/sse: gateway bertindak sebagai OAuth client. */
export interface BackendAuthConfig {
  type: "oauth";
  client_name?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
}

export interface BackendConfig {
  type?: BackendKind;
  enabled?: boolean;
  expose?: ExposeMode;
  allow_tools?: string[];
  deny_tools?: string[];
  // http / sse
  url?: string;
  headers?: Record<string, string>;
  auth?: BackendAuthConfig;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Konfigurasi OAuth server milik gateway (agen -> gateway), setelah di-resolve. */
export interface OAuthServerConfig {
  enabled?: boolean;
  password: string;
  store: string;
  access_ttl?: number;
  refresh_ttl?: number;
}

export interface ServerSettings {
  name?: string;
  host?: string;
  port?: number;
  public_url?: string;
  extra_public_urls?: string[];
  backend_redirect_url?: string;
  trust_proxy?: boolean;
  auth_token?: string;
  oauth: OAuthServerConfig | null;
  token_store: string;
  call_timeout?: number;
  lazy_threshold?: number;
  tools_cache_ttl?: number;
}

export interface CompactConfig {
  max_description?: number;
  strip_param_descriptions?: boolean;
  strip_output_schema?: boolean;
}

export interface GatewayConfig {
  server: ServerSettings;
  separator: string;
  servers: Record<string, BackendConfig>;
  profiles: Record<string, string[]>;
  compact?: CompactConfig | null;
}
