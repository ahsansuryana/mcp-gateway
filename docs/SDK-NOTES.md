# SDK-NOTES.md — MCP TypeScript SDK v2, verified

Sprint 0 task S0.3. Every claim below was read from a primary source (spec page under
`https://modelcontextprotocol.io/specification/2026-07-28/` saved in `docs/ref/`, or the
installed `.d.ts` / `.mjs` under `spikes/node_modules/`) or observed by running a file in
`spikes/`. Where something could NOT be verified, it is written up in
`docs/OPEN-QUESTIONS.md` instead of being asserted here.

## S0.2 — Installed versions

Scratch project: `spikes/` (`spikes/package.json`). Exact versions pinned, lockfile committed.

| Package | Version | `engines` |
|---|---|---|
| `@modelcontextprotocol/server` | 2.3.1 | `{"node": ">=20"}` |
| `@modelcontextprotocol/client` | 2.3.1 | `{"node": ">=20"}` |
| `@modelcontextprotocol/core` | 2.3.1 (transitive) | `{"node": ">=20"}` |
| `@modelcontextprotocol/node` | 2.1.1 | `{"node": ">=20"}` |
| `@modelcontextprotocol/express` | 2.0.2 | `{"node": ">=20"}` |
| `zod` | 4.6.5 | none |
| `express` | 5.1.0 | `{"node": ">= 18"}` |
| `cross-spawn` | 7.0.6 (spike only, see (d)) | `{"node": ">= 8"}` |

Commands:

```
$ npm view @modelcontextprotocol/server version      ->  2.3.1
$ npm view @modelcontextprotocol/client version      ->  2.3.1
$ npm view @modelcontextprotocol/node version        ->  2.1.1
$ npm view @modelcontextprotocol/express version     ->  2.0.2
$ npm view @modelcontextprotocol/hono version        ->  2.0.2
$ npm view zod version                               ->  4.6.5
$ npm view jsonc-parser version                      ->  3.3.1
$ npm view mcp-handler version                       ->  2.3.0
$ npm view @modelcontextprotocol/inspector version   ->  2.10.1
$ npm audit                                          ->  found 0 vulnerabilities
```

Package metadata verified with `npm view <pkg> engines peerDependencies dependencies`.

Peer-dependency facts that matter for D1/D16:

- `@modelcontextprotocol/node` peer-depends on `@modelcontextprotocol/server ^2.3.0` and
  depends on `hono ^4.11.4` + `@hono/node-server ^1.19.9`.
- `@modelcontextprotocol/express` peer-depends on `express ^4.18.0 || ^5.0.0` and
  `@modelcontextprotocol/server ^2.3.0`; depends on `cors ^2.8.5`.
- `@modelcontextprotocol/client` bundles `jose ^6.1.3`, `cross-spawn ^7.0.5`,
  `eventsource ^3.0.2`, `pkce-challenge ^5.0.0` — i.e. the OAuth machinery is already
  inside the client package, nothing extra to add in Sprint 5.

`mcp-handler` is at **2.3.0**, not "2", and its `peerDependencies` are
`{ next: ">=13.0.0", "@modelcontextprotocol/server": "^2.0.0" }` — it is a Next.js adapter.
It is **not** needed; see (j) and `docs/adr/0002-protocol-compatibility.md`.

Runtime constants, read from the installed packages
(`node -e "import('@modelcontextprotocol/server').then(m => console.log(...))"`):

```
LATEST_PROTOCOL_VERSION            = 2025-11-25
DEFAULT_NEGOTIATED_PROTOCOL_VERSION = 2025-03-26
SUPPORTED_PROTOCOL_VERSIONS        = ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]
DEFAULT_REQUEST_TIMEOUT_MSEC       = 60000
DEFAULT_MAX_REQUEST_BODY_SIZE      = 4194304
PROTOCOL_VERSION_META_KEY          = io.modelcontextprotocol/protocolVersion
CLIENT_INFO_META_KEY               = io.modelcontextprotocol/clientInfo
CLIENT_CAPABILITIES_META_KEY       = io.modelcontextprotocol/clientCapabilities
SUBSCRIPTION_ID_META_KEY           = io.modelcontextprotocol/subscriptionId
TRACEPARENT_META_KEY               = traceparent
localhostAllowedOrigins()          = ["localhost","127.0.0.1","[::1]"]
```

> Note: `2026-07-28` is **not** in `SUPPORTED_PROTOCOL_VERSIONS`. The modern era is not part
> of that 2025-era list; it is reached through `ClientOptions.versionNegotiation` on the
> client and `createMcpHandler` on the server. Do not use `SUPPORTED_PROTOCOL_VERSIONS` to
> decide what the gateway advertises.

---

## (a) A server whose list/call handlers are DYNAMIC

`registerTool` is **not** required. The low-level `Server` class exposes
`Protocol.setRequestHandler(method, handler)`, which is what a proxy needs: the handler
computes the result per request.

Import path: `@modelcontextprotocol/server`.
Symbol: `Server` (class) — marked `@deprecated` in favour of `McpServer` for the static
style, but it is the dynamic surface. Signature
(`spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`,
lines 2540-2544):

```ts
setRequestHandler<M extends RequestMethod>(
  method: M,
  handler: (request: RequestTypeMap[M], ctx: ContextT) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>
): void;
setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
  method: string,
  schemas: { params: P; result?: R },
  handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R]>
): void;
```

`Server` constructor: `new Server(_serverInfo: Implementation, options?: ServerOptions)`.
`ServerOptions` carries `capabilities`, `instructions`, `cacheHints`, `inputRequired`,
`requestState`, `jsonSchemaValidator`.

**Caveat from the same file (lines 2826-2831):** a server that *declares* a capability MUST
answer that capability's requests. With the low-level `Server` the author is responsible for
registering a handler for every declared capability — otherwise the SDK answers
`Method not found`. This matters for D8/S3: `server/discover` capabilities must be derived
from what healthy upstreams actually provide, never hard-coded optimistically.

Ran: `spikes/spike-1.mjs` (dynamic `tools/list` + `tools/call` proxying a remote upstream)
and `spikes/probe-subscriptions.mjs`. Output tail:

```
[gateway] tools/list merged names = upstream_boom, upstream_echo, upstream_needs_input
[gateway] tools/call forward params keys = name,arguments
{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Unknown tool: nope_missing"}}
```

## (b) Serving `POST /mcp` over HTTP statelessly, including `server/discover`

Import path: `@modelcontextprotocol/server`.
Symbols: `createMcpHandler`, `McpHttpHandler`, `McpServerFactory`, `McpRequestContext`,
`CreateMcpHandlerOptions`.

```ts
declare function createMcpHandler(
  factory: McpServerFactory,
  options?: CreateMcpHandlerOptions
): McpHttpHandler;

type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

interface McpRequestContext {
  era: 'legacy' | 'modern';
  authInfo?: AuthInfo;
  requestInfo?: Request;
}

interface McpHttpHandler {
  fetch: (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;
  close: () => Promise<void>;
  notify: ServerNotifier;   // .toolsChanged() .promptsChanged() .resourcesChanged() .resourceUpdated(uri)
  bus: ServerEventBus;
}
```

`CreateMcpHandlerOptions` fields that exist: `legacy`, `onerror`, `responseMode`, `bus`,
`maxSubscriptions`, `keepAliveMs`, `maxRequestBodySize`. There is **no** `port`/`host` here —
that is the framework's job.

Node mounting: `@modelcontextprotocol/node` exports
`toNodeHandler(handler, opts?): (req, res, parsedBody?) => Promise<void>` and
`toWebRequest(req, parsedBody?, options?)`.

```ts
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const handler = createMcpHandler(factory, { legacy: 'stateless', maxRequestBodySize: 1 << 20 });
http.createServer(toNodeHandler(handler)).listen(3000);
```

`server/discover` is **answered by the SDK**, not hand-rolled: `Server._ondiscover`
(createMcpHandler-D4NN8WsG.d.mts line ~3058) returns `supportedVersions`, `capabilities`,
`instructions` and the configured `server/discover` cache hint. Observed on the wire
(`spikes/out-spike-1.txt`):

```
POST /mcp  (mcp-protocol-version: 2026-07-28, mcp-method: server/discover)
200 application/json
{"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":false}},
 "resultType":"complete","ttlMs":60000,"cacheScope":"private",
 "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"mcp-gateway-spike","version":"0.0.0"}}},
 "jsonrpc":"2.0","id":1}
```

The entry is deliberately **validation-free** (its own doc comment says so): Origin/Host
validation must be mounted in front. Verified helpers:

```ts
import {
  hostHeaderValidationResponse, originValidationResponse,
  localhostAllowedHostnames, localhostAllowedOrigins,
} from '@modelcontextprotocol/server';
```

Observed (`spikes/out-probe-compat.txt`): `origin=https://evil.example -> 403`,
`https://allowed.example -> 200`, `null -> 403`, header absent -> 200.

## (c) Client over Streamable HTTP with custom headers

Import path: `@modelcontextprotocol/client`.

```ts
declare class StreamableHTTPClientTransport implements Transport {
  constructor(url: URL, opts?: StreamableHTTPClientTransportOptions);
}
```

Static per-request headers go through `requestInit` (line ~3426):

```ts
new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: 'Bearer ...', 'X-Foo': 'bar' } },
});
```

Precedence, per the same doc comment: transport-managed headers win over a same-named
caller entry — `Authorization` when `authProvider` yields a token, `mcp-session-id`,
`mcp-protocol-version`. So a static `Authorization` header is only sent while the provider
has no token. That is exactly the PLAN.md §6 rule ("OAuth adds `Authorization` only if no
static `Authorization` header is set") — but the SDK's actual rule is the reverse priority,
so §6's sentence needs an ADR. Logged as `Q-HDRPREC` in `docs/OPEN-QUESTIONS.md`.

Other `StreamableHTTPClientTransportOptions` that exist: `authProvider`,
`skipIssuerMetadataValidation`, `fetch`, `redirectPolicy` (default `'same-origin'`),
`reconnectionOptions`, `reconnectionScheduler`, `sessionId`, `protocolVersion`,
`onInsufficientScope` (default `'reauthorize'`), `maxStepUpRetries` (default 1).

Ran: `spikes/spike-1.mjs` — the gateway's upstream client is a
`StreamableHTTPClientTransport` with `Authorization` and `X-Gateway-Test` headers and
completed `server/discover` + `tools/list` + `tools/call` against the fake upstream.

## (d) Client over stdio, env handling, Windows `npx`

Import path: `@modelcontextprotocol/client/stdio`.

```ts
import { StdioClientTransport, getDefaultEnvironment, DEFAULT_INHERITED_ENV_VARS }
  from '@modelcontextprotocol/client/stdio';

new StdioClientTransport({
  command: string,            // required
  args?: string[],
  env?: Record<string, string>,
  stderr?: IOType | Stream | number,   // default "inherit"
  cwd?: string,
  maxBufferSize?: number,             // default 10 MB
});
// .stderr -> Stream | null, .pid -> number | null
```

**The actual spawn, read from `spikes/node_modules/@modelcontextprotocol/client/dist/stdio.mjs`:**

```js
this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
  env: { ...getDefaultEnvironment(), ...this._serverParams.env },
  stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
  shell: false,
  windowsHide: process.platform === "win32",
  cwd: this._serverParams.cwd
});
```

So, for D13:

- The allowlist always applies; a caller-supplied `env` is **merged on top**, never a
  replacement. PLAN.md D13's "SDK default env helper **if one exists** + config
  `environment`" is satisfied by doing nothing special — pass config `environment` as `env`.
- `DEFAULT_INHERITED_ENV_VARS` (win32): `APPDATA, COMSPEC, HOMEDRIVE, HOMEPATH,
  LOCALAPPDATA, PATH, PATHEXT, PROCESSOR_ARCHITECTURE, PROGRAMDATA, PROGRAMFILES,
  PROGRAMFILES(X86), PROGRAMW6432, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME, USERPROFILE,
  WINDIR`. On POSIX: `HOME, LOGNAME, PATH, SHELL, TERM, USER`.
- `getDefaultEnvironment()` additionally skips any value starting with `()`.

Windows `npx`: `shell: false`, and the spawn uses **`cross-spawn`** (the client package
depends on `cross-spawn ^7.0.5`), which is what resolves the `npx.cmd` shim. Verified
directly:

```
$ node -e "spawn('npx',['-y','--version'],{shell:false,windowsHide:true,env:{PATH,PATHEXT,COMSPEC,SYSTEMROOT,TEMP}})"
spawned ok, pid 10376
exit 0 stdout= "11.16.0" stderr= ""
```

Env isolation, observed through the proxy (`spikes/out-spike-2.txt`):

```
child env keys = [APPDATA, COMSPEC, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, LOGONSERVER, PATH,
 PATHEXT, PROCESSOR_ARCHITECTURE, PROGRAMDATA, PROGRAMFILES, PROGRAMFILES(X86),
 PROGRAMW6432, SPIKE_UPSTREAM_NAME, SPIKE_UPSTREAM_VALUE, SYSTEMDRIVE, SYSTEMROOT, TEMP,
 USERDOMAIN, USERNAME, USERPROFILE, WINDIR]
gatewaySecretLeaked: false
```

Two caveats for Sprint 4 / D13:

1. `LOGONSERVER` and `USERDOMAIN` appear in the child even though they are **not** in
   `DEFAULT_INHERITED_ENV_VARS` and not in the caller's `env`. They are injected by Windows
   itself. An S4.2 test that asserts "child env ⊆ allowlist" will fail on Windows; assert
   instead "no gateway secret is present".
2. Calling `child_process.spawn('npx', …)` directly (as `spike-3.mjs` first did) fails with
   `spawn npx ENOENT` on Windows. Use `cross-spawn`, or go through
   `StdioClientTransport`, which already does.

Server side: `@modelcontextprotocol/server/stdio` exports `serveStdio(factory, options?)`
and `StdioServerTransport`. `ServeStdioOptions` has `legacy: 'serve' | 'reject'`
(default `'serve'`), `transport`, `onerror`, `maxSubscriptions`.

## (e) How `ttlMs` / `cacheScope` are read and set

**Set (server).** `ServerOptions.cacheHints: Partial<Record<CacheableResultMethod, CacheHint>>`
where

```ts
type CacheScope = 'public' | 'private';
interface CacheHint { ttlMs?: number; cacheScope?: CacheScope; }
const CACHEABLE_RESULT_METHODS = ["tools/list","prompts/list","resources/list",
  "resources/templates/list","resources/read","server/discover"];
```

Resolution order at the 2026-era encode seam (doc comment, lines 2654-2676):
1. fields the handler returned on the result itself, when valid;
2. the configured hint (per-registration hint first, then the server-level per-operation
   hint, combined per field);
3. conservative defaults `{ ttlMs: 0, cacheScope: 'private' }`.

> `server/discover` IS in the cacheable list. PLAN.md §2 lists only tools/prompts/resources
> list + read. Not a contradiction, but PLAN.md is incomplete here.

Observed:

```
upstream tools/list       ttlMs/cacheScope => 20000 private
upstream server/discover  ttlMs/cacheScope => 900000 public
gateway  tools/list       ttlMs/cacheScope => 5000 private
```

**Read (client).** `Client` honours the result's `ttlMs`/`cacheScope`; per-call override is
`cacheMode: 'use' | 'refresh' | 'bypass'` on `listTools`/`listPrompts`/`listResources`/
`readResource`. `ClientOptions.defaultCacheTtlMs` supplies the TTL when a result arrives
without one (default `0`). `ClientOptions.responseCacheStore` and `cachePartition` control
where `'private'`-scoped entries land — **relevant to D11**: two gateway inbound principals
sharing one client must set `cachePartition` to the principal id, otherwise one principal's
`'private'` entry can serve another.

Zod v4 note: `zod@4.6.5` is installed. Exporting a JSON Schema from the zod schema is a
Sprint 1 task; the API to use has **not** been verified yet — logged as `Q-ZODJSON`.

## (f) `input_required`: surfacing on the client, returning from a server handler

**Server.** Return the builder's value straight from the handler:

```ts
import { inputRequired } from '@modelcontextprotocol/server';
// verified: createMcpHandler-D4NN8WsG.d.mts lines 1416-1486
return inputRequired({
  inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) },
  requestState: 'opaque-server-state',
});
// also: inputRequired.elicitUrl(...), .createMessage(...), .listRoots()
```

At least one of `inputRequests` / `requestState` is mandatory or the builder throws
`TypeError`. The seam additionally rejects embedded requests the client did not declare
support for, answering `-32021 MissingRequiredClientCapability`.

On the retry round the handler reads:

```ts
ctx.mcpReq.inputResponses        // Record<string, unknown> | undefined  (bare response objects)
ctx.mcpReq.droppedInputResponseKeys
ctx.mcpReq.requestState          // RequestStateAccessor: <T>() => T | undefined
```

plus helpers `acceptedContent(responses, key[, schema])` and
`inputResponse(responses, key)` returning `{kind:'missing'|'elicit'|'sampling'|'roots'}`.

**Client.** By default the client AUTO-FULFILS: `ClientOptions.inputRequired` drives
re-fulfilment through the same `setRequestHandler('elicitation/create', …)` registrations
and retries internally, up to `maxRounds` (observed: 10). To see the interim result, pass
`allowInputRequired: true` on the call.

**Spec placement of the retry fields** (confirmed against the spec page, not memory):
`inputResponses` and `requestState` are **siblings of `arguments` in `tools/call` params**,
not inside `_meta` — `docs/ref/spec-2026-07-28-server-tools.md` lines 209-232.

> **PROXY CONSEQUENCE that PLAN.md §5 does not state.** The SDK seam LIFTS `inputResponses`
> and `requestState` out of `params` before the handler runs. A gateway `tools/call` handler
> must therefore re-attach them explicitly to the upstream call, or MRTR silently fails.
> First run of the spike looped 10 times and ended with
> `Multi-round-trip request 'tools/call' still required input after 10 rounds`.
> Fixed in `spikes/spike-1.mjs`; recorded as `Q-MRTRPROXY` in `docs/OPEN-QUESTIONS.md`.

After the fix:

```
[gateway] tools/call forward params keys = name,arguments,inputResponses,requestState
callTool upstream_needs_input => {"content":[{"type":"text","text":"upstream-mrtr:complete state=upstream-minted-state"}]}
```

## (g) AbortSignal and timeout on client calls

```ts
type RequestOptions = {
  onprogress?: ProgressCallback;
  signal?: AbortSignal;        // -> AbortError from Protocol.request
  timeout?: number;            // ms; -> SdkError code REQUEST_TIMEOUT (default 60000)
  resetTimeoutOnProgress?: boolean;
  maxTotalTimeout?: number;
  allowInputRequired?: boolean;
} & TransportSendOptions;
```

`Client.callTool(params, options?: CallToolRequestOptions)` — `CallToolRequestOptions` is
`RequestOptions & { … }` (cache disposition). List verbs take `CacheableRequestOptions`.

On the **server** side the inbound signal is `ctx.mcpReq.signal: AbortSignal`.

Observed:

```
timeout threw => SdkError | code = REQUEST_TIMEOUT | Request timed out
hang aborted => SdkError SdkError | AbortError: This operation was aborted
upstream observed abort? => true
```

The second pair is the full chain: downstream abort → gateway `ctx.mcpReq.signal` →
upstream `callTool({signal})` → the fake upstream tool's own `ctx.mcpReq.signal` listener.

## (h) `subscriptions/listen` on client and server

**Client.**

```ts
listen(filter: SubscriptionFilter, options?: RequestOptions): Promise<McpSubscription>;
interface McpSubscription {
  readonly honoredFilter: SubscriptionFilter;   // from notifications/subscriptions/acknowledged
  close(): Promise<void>;                      // aborts stream AND sends notifications/cancelled
  readonly closed: Promise<'local' | 'graceful' | 'remote'>;
}
get autoOpenedSubscription(): McpSubscription | undefined;  // set by ClientOptions.listChanged
```

`SubscriptionFilter` fields (from `SubscriptionFilterSchema`; matches the spec page):
`toolsListChanged?: boolean`, `promptsListChanged?: boolean`,
`resourcesListChanged?: boolean`, `resourceSubscriptions?: string[]`.
Change notifications dispatch to the normal `setNotificationHandler` registrations.

On a 2025-era connection `listen()` throws `SdkErrorCode.MethodNotSupportedByProtocolVersion`.

**Server.** `createMcpHandler` owns the per-stream listen router; consumers only publish:

```ts
handler.notify.toolsChanged();        // notifications/tools/list_changed
handler.notify.promptsChanged();
handler.notify.resourcesChanged();
handler.notify.resourceUpdated(uri);
handler.bus.publish({ kind: 'tools_list_changed' });   // or supply your own ServerEventBus
```

`ServerNotifier`, `ServerEventBus`, `InMemoryServerEventBus` are exported from
`@modelcontextprotocol/server`. There is **no** `registerSubscriptionHandler` and no
per-subscription server API — the bus is the whole surface.

Observed (`spikes/out-probe-subscriptions.txt`):

```
listen() ack honoredFilter => {"toolsListChanged":true}
[client] received notifications/tools/list_changed
notifications received by the client => ["tools/list_changed"]
publishing on the UPSTREAM bus...
notifications after upstream publish => ["tools/list_changed"]   <-- unchanged
subscription.close()... sub.closed => local
```

> The last pair is the S3.4 finding: publishing on the **upstream** bus does **not** reach
> the gateway's downstream listeners. The gateway must subscribe upstream with
> `client.listen(...)` and re-publish on its own `handler.notify`. Logged as
> `Q-SUBSFWD` in `docs/OPEN-QUESTIONS.md`.

## (i) The OAuth client provider interface

Import path: `@modelcontextprotocol/client`, symbol `OAuthClientProvider`
(`spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts` line 430).

Required members:

| Member | Signature | Notes |
|---|---|---|
| `redirectUrl` | `string \| URL \| undefined` | `undefined` for non-interactive flows |
| `clientMetadata` | `OAuthClientMetadata` | |
| `clientInformation` | `(ctx?) => StoredOAuthClientInformation \| undefined \| Promise<…>` | `ctx.issuer` is the key for per-AS credentials |
| `tokens` | `(ctx?) => StoredOAuthTokens \| undefined \| Promise<…>` | with `ctx === undefined` (per-request bearer read) must return the most recent set, **not** `undefined` |
| `saveTokens` | `(tokens, ctx?) => void \| Promise<void>` | |
| `redirectToAuthorization` | `(url: URL) => void \| Promise<void>` | |
| `saveCodeVerifier` | `(v: string) => void \| Promise<void>` | |
| `codeVerifier` | `() => string \| Promise<string>` | |
| `state?` | `() => string \| Promise<string>` | optional |

Optional members that exist: `clientMetadataUrl`, `saveClientInformation`, `dpop`,
`validateResourceURL`, `invalidateCredentials`, `prepareTokenRequest`, `addClientAuthentication`.

Ready-made implementations shipped in the package: `ClientCredentialsProvider`,
`PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`, `CrossAppAccessProvider`.
Free functions: `auth()`, `startAuthorization()`, `exchangeAuthorization()`,
`refreshAuthorization()`, `registerClient()`, `fetchToken()`, `discoverOAuthMetadata()`,
`discoverOAuthProtectedResourceMetadata()`, `discoverAuthorizationServerMetadata()`,
`selectResourceURL()`, `validateAuthorizationResponseIssuer()`, `prepareAuthorizationCodeRequest()`,
`resolveClientMetadata()`, `assertSecureTokenEndpoint()`.

Sprint 5's requirements map cleanly onto it:

- PKCE S256: `pkce-challenge` is already a dependency of the client package; `saveCodeVerifier` /
  `codeVerifier()` are the provider seam.
- DCR deprecation → the SDK's `resolveClientMetadata(provider)` reads `clientMetadataUrl`
  when present, i.e. the Client ID Metadata Document path is the provider's job to opt into.
- Per-issuer keying: `OAuthClientInformationContext` carries `issuer`; pass it to
  `saveTokens`/`clientInformation`/`tokens`.
- `iss` (RFC 9207) validation: `validateAuthorizationResponseIssuer` + the issuer-echo check
  in metadata discovery (`skipIssuerMetadataValidation` opts out).

**Not exercised at runtime in Sprint 0** — no authorization server was available. See
`docs/OPEN-QUESTIONS.md` `Q-OAUTH-RUN`.

## (j) Which protocol versions the v2 server accepts, and which the v2 client speaks

This is the most consequential finding of Sprint 0. Summary:

- **Server:** by default `createMcpHandler(factory)` serves BOTH eras. `legacy: 'stateless'`
  is the default; `'reject'` is opt-in for a modern-only endpoint.
- **Client:** by default speaks the **2025** era. `versionNegotiation` must be set to
  `'auto'` or `{ pin: '2026-07-28' }` to reach the modern era.

```ts
// createMcpHandler options
legacy?: 'stateless' | 'reject';   // default 'stateless'
responseMode?: 'auto' | 'sse' | 'json';  // default 'auto'
```

`'stateless'` serves 2025-era traffic by building a fresh instance from the **same factory**
per request over a transport constructed with only `sessionIdGenerator: undefined`. GET and
DELETE (2025 session operations) are answered `405`. `'reject'` answers a legacy-classified
request with the unsupported-protocol-version error instead.

```ts
// ClientOptions
versionNegotiation?: VersionNegotiationOptions;   // { mode?: 'legacy' | 'auto' | { pin: string }, probe?: {...} }
// @default mode = 'legacy'
```

`mode: 'auto'` probes with `server/discover` first, falls back to plain `initialize` on
legacy/unrecognized signals. `{ pin: '2026-07-28' }` pins with no fallback. Pinning a
non-modern revision throws at construction:
`versionNegotiation: { pin: '1999-01-01' } is not a modern protocol revision — pinning is
for 2026-07-28 and later`.

`isLegacyRequest(request, parsedBody?, options?)` is exported so a hand-wired composition
can branch on the same decision the entry makes.

### Observed matrix (`spikes/out-probe-compat.txt`, `spikes/out-spike-3.txt`)

```
isLegacyRequest: modern tools/list -> false ; 2025 initialize -> true

default client            -> modern-only server : FAILED SdkHttpError -32022 Unsupported protocol version: 2025-11-25
default client            -> stateless-default  : connect OK, tools = ping_tool
auto client               -> modern-only server : connect OK, discover=["2026-07-28"], tools = ping_tool
pinned 2026-07-28 client  -> modern-only server : connect OK, discover=["2026-07-28"], tools = ping_tool
auto client               -> legacy-reject      : connect OK, discover=["2026-07-28"]
pinned 1999-01-01 client  -> stateless-default  : FAILED TypeError at construction

raw unknown MCP-Protocol-Version -> 400 {"code":-32022, "data":{"supported":["2026-07-28"],"requested":"1999-01-01"}}
raw GET    on the MCP endpoint -> 405 {"code":-32000,"message":"Method not allowed."}
raw DELETE on the MCP endpoint -> 405 {"code":-32000,"message":"Method not allowed."}
raw Mcp-Method/body mismatch  -> 400 {"code":-32020, "message":"Bad Request: the request headers and body disagree: ..."}
raw missing Mcp-Method        -> 400 {"code":-32020, "message":"... the required Mcp-Method header is absent"}
body over the limit (5 MiB)   -> 413 {"code":-32000,"message":"Payload Too Large: Request body must not exceed 4194304 bytes"}
```

### Official MCP Inspector CLI against the gateway

```
$ npx -y @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:3152/mcp \
    --transport http --method tools/list --format json
[exit 0]
{"result":{"tools":[{"name":"up_add",...},{"name":"up_greet",...}]}}

$ ... --method tools/call --tool-name up_add --tool-arg a=2 --tool-arg b=40 --format json
[exit 0]
{"result":{"content":[{"type":"text","text":"42"}], ...}}

$ ... --cli http://127.0.0.1:3151/mcp --transport http --method tools/list   # legacy:'reject' upstream
[exit 1]
{"error":{"message":"Error POSTing to endpoint: {\"code\":-32022,\"message\":\"Unsupported protocol version: 2025-11-25\",...}"}}

$ ... --cli http://127.0.0.1:3151/mcp --transport http --protocol-era modern --method tools/list
[exit 0]
{"result":{"tools":[{"name":"add",...},{"name":"greet",...}]}}
```

The Inspector's `protocolEra` **defaults to `legacy`**; `--protocol-era modern|auto|legacy`
overrides it for one run. Because the gateway was built with the default
`legacy: 'stateless'`, the Inspector worked against it with no flags at all.

Third-party `mcp-handler` was **not** needed: the official SDK already serves 2025-era
clients from the same factory, on the same endpoint, with no custom code. Recorded in
`docs/adr/0002-protocol-compatibility.md`.

---

## Other verified spec facts that PLAN.md does not state (found while reading the pages)

| Fact | Source |
|---|---|
| `MCP-Protocol-Version` header is **required on every POST** and MUST equal `_meta["io.modelcontextprotocol/protocolVersion"]`; mismatch is `-32020 HeaderMismatch` | `docs/ref/spec-2026-07-28-basic-transports-streamable-http.md` |
| `_meta` envelope keys are required on every modern request; a missing `clientCapabilities` is answered `-32602` with `data.envelope` | same page + observed in `out-probe-compat.txt` |
| Invalid `Origin` MUST be `403` (SDK returns 403) | same page, "Security & Endpoint" |
| `Mcp-Name` values outside the header-safe ASCII set use a `=?base64?<b64>?=` sentinel; servers MUST decode before comparing to the body | same page, "Value Encoding" |
| `x-mcp-header` schema annotation mirrors a tool parameter into `Mcp-Param-{name}`; **clients MUST support it** and MUST reject tool definitions whose annotation violates the constraints (excluding the tool from `tools/list`) | same page + changelog minor change 4 |
| New spec error codes: `HeaderMismatch -32020`, `MissingRequiredClientCapability -32021`, `UnsupportedProtocolVersion -32022`. `-32000..-32019` is implementation-defined and "new implementations SHOULD NOT use" it | `docs/ref/spec-2026-07-28-basic-index.md` "Error Codes" |
| The SDK answers 405 GET/DELETE and 413 oversize bodies with code **`-32000`**, i.e. the sub-range the spec says new implementations should avoid | `spikes/out-probe-compat.txt` |
| DCR is deprecated in favour of Client ID Metadata Documents; clients MUST key persisted credentials by issuer; `application_type` is required when registering | `docs/ref/spec-2026-07-28-changelog.md` |
| MRTR results must NOT be cached (they carry `inputResponses`/`requestState`, which are not part of the cache key) | `docs/ref/spec-2026-07-28-server-utilities-caching.md` |

---

## Files

| File | What it proves |
|---|---|
| `spikes/spike-1.mjs` | (a)(b)(c)(e)(f)(g) — remote proxy, dynamic handlers, raw wire, MRTR passthrough, timeout |
| `spikes/spike-2.mjs` + `spikes/fake-stdio-server.mjs` | (d) — stdio client transport, env allowlist, npx on Windows |
| `spikes/spike-3.mjs` | S0.4 — official MCP Inspector CLI against the skeleton |
| `spikes/probe-compat.mjs` | (j) — protocol version matrix, headers, 405/413/403 |
| `spikes/probe-subscriptions.mjs` | (e)(h)(g) — ttlMs/cacheScope on the wire, listen/notify, abort chain |
| `spikes/probe-progress.mjs` | (g) + S3.6 groundwork — `notifications/progress` and trace context forwarding |
| `spikes/out-*.txt` | captured stdout of each of the above |