# CallRail MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that connects Claude.ai to the [CallRail API](https://apidocs.callrail.com), giving Claude full programmatic access to your CallRail account.

## Features

**68 tools across 14 sections of the CallRail API:**

| Section | Tools |
|---|---|
| Calls | List, get, create outbound, update, summarize, timeseries, recording, page views |
| Tags | List, create, update, delete |
| Companies | List, get, create, update, bulk update, disable |
| Form Submissions | List, create, update, ignore fields, summarize |
| Integrations | List, get, create, update, disable |
| Integration Filters | List, get, create, update, delete |
| Notifications | List, create, update, delete |
| Outbound Caller IDs | List, get, create, delete |
| SMS Threads | List, get, update |
| Text Messages | List conversations, get conversation, send |
| Summary Emails | List, get, create, update, delete |
| Message Flows | List, get, create, update |
| Trackers | List, get, create, update, disable |
| Users | List, get, create, update, delete |

## Requirements

- Node.js 18+
- A [CallRail account](https://www.callrail.com) with API access
- A Railway account (or any Node.js hosting)

## Environment Variables

| Variable | Description |
|---|---|
| `CALLRAIL_API_TOKEN` | Your CallRail API token. Found in CallRail → Settings → API Access |
| `CALLRAIL_ACCOUNT_ID` | Your CallRail account ID (e.g. `ACC8154748ae6bd4e278a7cddd38a662f4f`) |
| `PORT` | Server port (default: `3000`, Railway sets this automatically) |

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app)

1. Fork or clone this repo and push to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Add the environment variables above under **Settings → Variables**
4. Railway will build and deploy automatically using `railway.toml`
5. Your MCP endpoint will be at:
   ```
   https://[service-name]-production.up.railway.app/mcp
   ```

## Connect to Claude.ai

1. Go to **Claude.ai → Settings → Connectors**
2. Click **Add custom connector**
3. Paste your Railway `/mcp` URL
4. No authentication required

> **Note:** Claude.ai's MCP connector only supports OAuth — this server intentionally runs without authentication as per Railway deployment best practices. Do not expose this server publicly without a firewall or private networking in place.

## Local Development

```bash
npm install
npm run build
CALLRAIL_API_TOKEN=your_token CALLRAIL_ACCOUNT_ID=your_account_id npm start
```

Test the health check:
```bash
curl http://localhost:3000/health
# {"status":"ok","service":"callrail-mcp"}
```

List available tools:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Project Structure

```
src/
  index.ts       # All 68 tools + Express server
package.json
tsconfig.json
railway.toml
```

## Built With

- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [Express](https://expressjs.com) — HTTP server
- [esbuild](https://esbuild.github.io) — Bundler (avoids OOM on large TypeScript projects)

## License

MIT
