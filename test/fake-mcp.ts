// A tiny MCP server over stdio for tests: one read-only tool, one that is not.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text back.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}));
server.registerTool("send", { description: "Pretend to send a message.", inputSchema: { to: z.string() } }, async ({ to }) => ({
  content: [{ type: "text", text: `sent to ${to} with token ${process.env.FAKE_TOKEN ?? "none"}` }],
}));
await server.connect(new StdioServerTransport());
