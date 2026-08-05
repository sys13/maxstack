/**
 * The web app's view of the MCP wire protocol.
 *
 * The dispatcher itself lives in `@maxstack/mcp` (`jsonrpc.ts`) so that every
 * transport shares one implementation — this HTTP host and the CLI's stdio
 * host (`maxstack mcp`). This module stays as the app-local import point the
 * route and its tests already use.
 */

export {
	handleMcpRequest,
	type JsonRpcRequest,
	type JsonRpcResponse,
	MCP_PROTOCOL_VERSION,
	type McpContext,
	type McpRequestContext,
} from '@maxstack/mcp'
