import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** Backend MCP palsu untuk tes: punya tool (termasuk yang membawa UI), resource, template, dan prompt. */
const server = new Server(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, extensions: { "io.modelcontextprotocol/ui": {} } } },
);

const empty = { type: "object", properties: {} } as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "plain", description: "tool biasa", inputSchema: empty },
    { name: "show", description: "tool dengan UI", inputSchema: empty, _meta: { ui: { resourceUri: "ui://app/widget" } } },
    { name: "link", description: "mengembalikan resource_link", inputSchema: empty },
    { name: "app_only", description: "tool khusus aplikasi", inputSchema: empty, _meta: { ui: { visibility: ["app"] } } },
    { name: "caps", description: "mengembalikan capability client", inputSchema: empty },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "link") {
    return { content: [{ type: "resource_link", uri: "file:///notes.txt", name: "notes" }] };
  }
  if (req.params.name === "caps") {
    return { content: [{ type: "text", text: JSON.stringify(server.getClientCapabilities() ?? {}) }] };
  }
  return { content: [{ type: "text", text: "ok" }] };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "file:///notes.txt", name: "notes", mimeType: "text/plain" },
    { uri: "file:///secret.txt", name: "secret", mimeType: "text/plain" },
    { uri: "ui://app/widget", name: "widget", mimeType: "text/html;profile=mcp-app" },
  ],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ uriTemplate: "file:///docs/{name}", name: "docs" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  if (uri === "file:///notes.txt") return { contents: [{ uri, mimeType: "text/plain", text: "isi catatan" }] };
  if (uri === "file:///secret.txt") return { contents: [{ uri, mimeType: "text/plain", text: "rahasia" }] };
  if (uri === "ui://app/widget") {
    return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<h1>widget</h1>", _meta: { ui: { csp: {} } } }] };
  }
  if (uri.startsWith("file:///docs/")) return { contents: [{ uri, mimeType: "text/plain", text: `doc ${uri.slice(13)}` }] };
  throw new Error(`resource tidak ada: ${uri}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    { name: "greet", description: "menyapa", arguments: [{ name: "name", required: true }] },
    { name: "hidden", description: "harus bisa disembunyikan" },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === "greet") {
    return {
      description: "menyapa",
      messages: [
        { role: "user", content: { type: "text", text: `Halo ${req.params.arguments?.name ?? "?"}` } },
        { role: "user", content: { type: "resource", resource: { uri: "file:///notes.txt", text: "isi catatan" } } },
      ],
    };
  }
  if (req.params.name === "hidden") {
    return { messages: [{ role: "user", content: { type: "text", text: "tersembunyi" } }] };
  }
  throw new Error(`prompt tidak ada: ${req.params.name}`);
});

server.setRequestHandler(CompleteRequestSchema, async (req) => {
  const { ref, argument, context } = req.params;
  const pick = (all: string[]) => ({
    completion: { values: all.filter((v) => v.toLowerCase().startsWith(argument.value.toLowerCase())) },
  });
  if (ref.type === "ref/prompt" && ref.name === "greet" && argument.name === "name") {
    return context?.arguments?.lang === "id" ? pick(["Halo"]) : pick(["Dina", "Dewi", "Budi"]);
  }
  if (ref.type === "ref/resource" && ref.uri === "file:///docs/{name}" && argument.name === "name") {
    return pick(["a.txt", "b.txt"]);
  }
  return { completion: { values: [] } };
});

await server.connect(new StdioServerTransport());
