![Demo](demo.gif)

<small>Video sped up for demo purposes</small>

# Runway API MCP Server

This repository holds the code for a MCP server that calls the Runway API.

## Tools

The following tools are available in this MCP:

| Tool Name              | Description                                                 | Parameters                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runway_listModels`    | Lists available models per capability and the recommended default for each | (none) |
| `runway_generateVideo` | Generates a video from an image and a text prompt           | - promptImage <br/> - promptText (optional) <br/> - ratio <br/> - duration <br/> - model (optional)                                                                   |
| `runway_generateImage` | Generates an image from a text prompt, and reference images | - promptText <br/> - referenceImages (note that uploaded images won't work as references, only previously generated ones, or URLs to images will work.) <br/> - ratio <br/> - model (optional) |
| `runway_upscaleVideo`  | Upscale a video to a higher resolution                      | - videoUri <br/> - model (optional)                                                                                                                                   |
| `runway_editVideo`     | Edits a video, optionally provide reference images.         | - videoUri, referenceImages, promptText <br/> - model (optional)                                                                                                      |
| `runway_generateAudio` | Generates spoken audio (text-to-speech) from text            | - promptText <br/> - voice (optional) <br/> - model (optional)                                                                                                        |
| `runway_getTask`       | Gets the details of a task                                  | - taskId                                                                                                                                                              |
| `runway_cancelTask`    | Cancels or deletes a task                                   | - taskId                                                                                                                                                              |
| `runway_getOrg`        | Get organization information                                |
|                        |

Generation tools accept an optional `model` parameter to override the recommended
default. Recommended models: Nano Banana Pro (`gemini_image3_pro`) for images, Seedance
(`seedance2`) for video, and Aleph (`aleph2`) for video editing. Valid `ratio`,
`duration`, and other parameter values are model-specific, so `runway_listModels` returns
the exact valid values and required parameters for every model — call it before choosing a
`ratio`/`duration`.

## Prerequisites

Before starting, you'll need to have setup your Developer account on the [Runway API](https://dev.runwayml.com/), [setup Billing](https://docs.dev.runwayml.com/guides/setup/), and also created an API Key.

You'll also need [Node.js](https://nodejs.org/) setup.

## Setup

1. Clone this repository and save it to a folder on your computer. Remember where you saved this folder because you'll need it in a later step.

2. Run `npm install` in the folder, then `npm run build`. You should now see a new folder called `build` with a `index.js` file inside. If you later modify any source files, run `npm run build` again to pick up the changes.

### Using the MCP as a Claude Desktop extension (recommended)

This installs the server as an unpacked Claude Desktop extension, so you don't have to edit any config files by hand.

3. Launch Claude Desktop and open **Settings**.

4. Go to **Extensions**, then **Advanced Settings**.

5. Click **Install Unpacked Extension** and select the folder you cloned in step 1 (for example `/Users/edwin/runway-api-mcp-server`). Click **Install** on the prompt.

6. Get your API key from [https://dev.runwayml.com](https://dev.runwayml.com), paste it into the installed extension's settings, then **Enable** the extension.

7. Now, try asking Claude to generate an image!

### Using the MCP with Claude Desktop (config file)

Alternatively, register the server manually through Claude's config file.

1. Follow the [MCP quickstart instructions](https://modelcontextprotocol.io/quickstart/user#2-add-the-filesystem-mcp-server) to setup a config file for Claude. If you already have it, open it by running:

MacOS

```bashrc
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Windows

```powershell
notepad %APPDATA%\Claude\claude_desktop_config.json
```

2. Add the `runway-api-mcp-server` to the config, make sure to replace the file path and Runway API key.

```json
{
  "mcpServers": {
    "runway-api-mcp-server": {
      "command": "node",
      "args": [
        "<ABSOLUTE_PATH_TO_YOUR_CLONED_REPO_FROM_STEP_1>/build/index.js"
      ],
      "env": {
        "RUNWAYML_API_SECRET": "<YOUR_RUNWAY_API_KEY_HERE>",
        "MCP_TOOL_TIMEOUT": "1000000"
      }
    }
  }
}
```

3. Now restart Claude Desktop, and you should see the `runway-api-mcp-server` in Claude's tools:

![Runway MCP Server Screenshot](screenshot.png)

4. Now, try asking Claude to generate images or videos!

> [!NOTE]  
> Images generated by the Runway API lives only for 24 hours at the generated link. There is no way to recover them after this link expires. Make sure to download the images before they expire.

## Deploy as a remote MCP server

The same code can run as an HTTP MCP server, which lets clients like
[claude.ai web](https://claude.ai), Cursor, Zed, and Windsurf connect to a
single hosted URL instead of installing the extension locally.

### Local HTTP development

```bash
RUNWAYML_API_SECRET=key_xxx npm run start:http
# server listens on http://0.0.0.0:3000/mcp
curl http://127.0.0.1:3000/healthz   # → {"ok":true}
```

To test from web clients (`claude.ai`) without deploying, use a tunnel that
returns HTTPS. Cloudflared works; ngrok is currently blocked by Anthropic's
connector backend:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Use the printed `https://<random>.trycloudflare.com/mcp` as the connector URL.

### Deploying to Railway

[Railway](https://railway.app/) deploys the HTTP server with zero config.

```bash
npm i -g @railway/cli           # one-time
railway login
railway init                    # create a new project, link this folder
railway up                      # builds & deploys
railway domain                  # provisions https://<your-app>.up.railway.app
```

Set environment variables in the Railway dashboard (or `railway variables`):

| Variable               | Required | Purpose                                                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `RUNWAYML_API_SECRET`  | optional | Server-side API key. Used as fallback when `REQUIRE_AUTH=false`. **Do not set for public deployments.**       |
| `REQUIRE_AUTH`         | yes      | Set to `true` for any public/multi-tenant deployment. Forces clients to send their key as `Authorization: Bearer <key>`. |
| `PORT`                 | auto     | Injected by Railway. The server reads `process.env.PORT`.                                                     |

Connect from claude.ai web:

1. Settings → Connectors → Add custom connector
2. URL: `https://<your-app>.up.railway.app/mcp`
3. Leave OAuth fields blank (Bearer-key flow)

### Public deployment auth model

For public, multi-tenant hosting, every user supplies their own Runway API
key:

```bash
curl -X POST https://<your-app>.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <user_runway_key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

When `REQUIRE_AUTH=true`, requests without a Bearer header receive a 401.
Bearer keys take priority over `RUNWAYML_API_SECRET` even when both are set.
