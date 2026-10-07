// A plugin is a folder: plugin.json declares the tools, this module implements them.
// Only declared tools are registered. `secret` below is exported but not declared,
// so no agent can ever call it.
//
// Each tool gets (args, ctx). ctx has: agent { id, name }, thread, workspace, signal, log.
// Return a string, or { text, image } where image is a path to a png/jpg.

export const tools = {
  async greet({ name }, ctx) {
    return `Hello, ${name}. This is ${ctx.agent.name}, via the hello plugin.`;
  },
  async roll({ sides = 6 }) {
    return String(1 + Math.floor(Math.random() * sides));
  },
  async secret() {
    return "you should never see this";
  },
};
