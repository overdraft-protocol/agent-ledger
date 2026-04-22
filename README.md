# agent-ledger-mcp

Modern lightweight MCP server with **Streamable HTTP** transport and a simple file-backed KV store.

## Run

```bash
npm run build
npm start
```

Defaults:
- **HTTP**: `http://127.0.0.1:3210/mcp`
- **KV file**: `.mcp-kv-store.json` (override with `MCP_KV_PATH=/path/to/file.json`)
- **Auth (optional)**: set `SHARED_SERVER_TOKEN`, send `Authorization: Bearer <token>`

## Example

List tools (matches the required JSON shape):

```bash
curl -sS -X POST http://127.0.0.1:3210/mcp \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Streamable HTTP-style response (SSE framing):

```bash
curl -sS -X POST http://127.0.0.1:3210/mcp \
  -H 'accept: text/event-stream' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

