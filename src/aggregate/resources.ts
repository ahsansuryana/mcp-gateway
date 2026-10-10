// PLAN.md S3.1 / D5: resource namespacing by rewriting the URI to
// `gw://<server>/<encodeURIComponent(originalUri)>`; `resources/read` decodes and routes.
//
// Why a rewrite: original resource URIs are arbitrary schemes (`file://`, `custom:`) and
// two upstreams can legitimately publish the SAME URI, so a pass-through aggregate would be
// ambiguous (PLAN.md D5).

import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';

export const GATEWAY_RESOURCE_SCHEME = 'gw';

/** D5: the gateway's own resource scheme. */
export function encodeResourceUri(server: string, originalUri: string): string {
  return `${GATEWAY_RESOURCE_SCHEME}://${server}/${encodeURIComponent(originalUri)}`;
}

export interface DecodedResourceUri {
  server: string;
  originalUri: string;
}

/**
 * Decodes a `gw://` URI. Returns `null` for anything the gateway could not have produced,
 * which the caller turns into a `-32602` protocol error.
 */
export function decodeResourceUri(uri: string): DecodedResourceUri | null {
  const prefix = `${GATEWAY_RESOURCE_SCHEME}://`;
  if (!uri.startsWith(prefix)) return null;

  const rest = uri.slice(prefix.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;

  const server = rest.slice(0, separator);
  const encoded = rest.slice(separator + 1);
  if (encoded.length === 0) return null;

  let originalUri: string;
  try {
    originalUri = decodeURIComponent(encoded);
  } catch {
    // A malformed percent-escape cannot have come from encodeURIComponent.
    return null;
  }
  if (originalUri.length === 0) return null;

  return { server, originalUri };
}

/** S3.1: an unknown server or an undecodable URI is `-32602` (PLAN.md S3.1). */
export function resourceNotFound(uri: string): ProtocolError {
  return new ProtocolError(INVALID_PARAMS, `Unknown resource: ${uri}`);
}