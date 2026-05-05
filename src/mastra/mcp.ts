import { MCPClient } from '@mastra/mcp';

export const mcpClient = new MCPClient({
  servers: {
    'notebooklm': {
      command: 'uvx',
      args: ['notebooklm-mcp', 'server'],
    },
  },
});
