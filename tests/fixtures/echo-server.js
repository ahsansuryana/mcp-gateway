// Backend MCP stdio minimal untuk test. Tool: echo, secret.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Mengembalikan teks yang dikirim",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    { name: "secret", description: "Tool yang harus diblokir deny_tools", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "echo") return { content: [{ type: "text", text: `echo: ${req.params.arguments?.text}` }] };
  return { content: [{ type: "text", text: "rahasia" }] };
});

await server.connect(new StdioServerTransport());
