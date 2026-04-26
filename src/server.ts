import "dotenv/config";
import fetch, { RequestInit } from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const API_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";

// Inline preview cap: stdio MCP transport is limited to ~1MB tool results.
// Runway previewUrls are small thumbnails so they fit; full-quality output
// does not.
const MAX_INLINE_BYTES = 900 * 1024;

const VIEWER_URI = "ui://runway/media-viewer.html";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Single source of truth: <repo-root>/assets/media-viewer.html.
// __dirname is `src/` when running via tsx and `build/` when running compiled,
// so `../assets` resolves to the same file in both. The DXT bundler copies
// `assets/` alongside `build/` so this also works inside the installed
// extension.
const VIEWER_HTML_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "media-viewer.html"
);

let cachedViewerHtml: string | undefined;
async function loadViewerHtml(): Promise<string> {
  if (!cachedViewerHtml) {
    cachedViewerHtml = await fs.readFile(VIEWER_HTML_PATH, "utf-8");
  }
  return cachedViewerHtml;
}

type InlineImage = { type: "image"; data: string; mimeType: string };

interface RunwayTask {
  id: string;
  status:
    | "PENDING"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED"
    | "THROTTLED";
  url?: string;
  error?: string;
  [key: string]: any;
}

export interface CreateServerOptions {
  /**
   * Runway API secret. Defaults to `process.env.RUNWAYML_API_SECRET`.
   * Required at request time — if neither is set, calls fail with 401.
   */
  runwayApiSecret?: string;
  /**
   * Absolute public base URL (e.g. https://runway-mcp.up.railway.app), used
   * to construct the icon URL advertised via `serverInfo.icons`. The MCP
   * spec requires absolute URIs. For DXT installs this is irrelevant — the
   * manifest's `icon` field handles the desktop UI. Defaults to
   * `process.env.PUBLIC_URL`; if unset, no icon is advertised.
   */
  publicUrl?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const secret = options.runwayApiSecret ?? process.env.RUNWAYML_API_SECRET;
  const publicUrl = options.publicUrl ?? process.env.PUBLIC_URL;
  // The 2025-06-18 MCP spec adds an `icons` field on server info. Some
  // clients (Claude Desktop, IDE clients) render this; claude.ai web does
  // not yet, but sending it is harmless and forward-compatible.
  const icons = publicUrl
    ? [
        {
          src: `${publicUrl.replace(/\/$/, "")}/icon.png`,
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ]
    : undefined;
  const server = new McpServer({
    name: "Runway",
    title: "Runway",
    version: "1.0.0",
    websiteUrl: "https://runwayml.com",
    ...(icons ? { icons } : {}),
  });

  async function fetchPreviewInline(
    previewUrls: string[] | undefined
  ): Promise<InlineImage | null> {
    if (!previewUrls || previewUrls.length === 0) return null;
    for (const url of previewUrls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_INLINE_BYTES) continue;
        const mimeType =
          res.headers.get("content-type")?.split(";")[0].trim() ||
          "image/jpeg";
        if (!mimeType.startsWith("image/")) continue;
        return { type: "image", data: buf.toString("base64"), mimeType };
      } catch {
        // try next preview
      }
    }
    return null;
  }

  async function callRunway(
    p: string,
    opts: Partial<RequestInit> = {}
  ): Promise<unknown> {
    if (!secret) {
      throw new Error(
        "RUNWAYML_API_SECRET is not configured on the MCP server."
      );
    }
    const res = await fetch(`${API_BASE}${p}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Runway-Version": RUNWAY_VERSION,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    } as RequestInit);
    if (!res.ok) throw new Error(`Runway ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function waitForTaskCompletion(taskId: string): Promise<RunwayTask> {
    while (true) {
      const task = (await callRunway(`/tasks/${taskId}`)) as RunwayTask;
      if (
        task.status === "SUCCEEDED" ||
        task.status === "FAILED" ||
        task.status === "CANCELLED"
      ) {
        return task;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  async function callRunwayAsync(
    p: string,
    opts: Partial<RequestInit> = {}
  ): Promise<RunwayTask> {
    const response = (await callRunway(p, opts)) as {
      id?: string;
    } & RunwayTask;
    if (response?.id) return waitForTaskCompletion(response.id);
    return response;
  }

  async function buildVideoResponse(task: RunwayTask, prompt?: string) {
    if (task.status !== "SUCCEEDED" || !task.output?.[0]) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
      };
    }
    const videoUrl: string = task.output[0];
    const preview = await fetchPreviewInline(task.previewUrls);
    const text = [
      `Video ready (taskId: ${task.id}).`,
      ``,
      `Render this exact markdown link in your reply so the user can download it: [Download video](${videoUrl})`,
      ``,
      `Do not mention the URL string itself or its expiry. If the user later asks to redownload and the link no longer works, call runway_refreshTaskUrl with taskId="${task.id}" to get a fresh URL.`,
    ].join("\n");
    const baseContent = preview
      ? [preview, { type: "text" as const, text }]
      : [{ type: "text" as const, text }];
    return {
      content: baseContent,
      structuredContent: {
        kind: "video",
        url: videoUrl,
        taskId: task.id,
        prompt,
      },
    };
  }

  // The MCP-Apps inline viewer (HTML iframe).
  server.registerResource(
    "runway-media-viewer",
    VIEWER_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: VIEWER_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await loadViewerHtml(),
          _meta: {
            ui: {
              csp: {
                resourceDomains: [
                  "https://*.cloudfront.net",
                  "https://*.runwayml.com",
                  "https://*.amazonaws.com",
                ],
              },
              prefersBorder: true,
            },
          },
        },
      ],
    })
  );

  server.registerTool(
    "runway_generateVideo",
    {
      title: "Generate Video",
      description:
        "Generate a video from an image and a text prompt. Accepted ratios are 1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672. Use 1280:720 by default. For duration, there are only either 5 or 10 seconds. Use 5 seconds by default. If the user asks to generate a video, always first use generateImage to generate an image first, then use the image to generate a video.",
      inputSchema: {
        promptImage: z.string(),
        promptText: z.string().optional(),
        ratio: z.string(),
        duration: z.number(),
      },
      annotations: {
        title: "Generate Video",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async (params) => {
      const task = await callRunwayAsync("/image_to_video", {
        method: "POST",
        body: JSON.stringify({
          model: "gen4_turbo",
          promptImage: params.promptImage,
          promptText: params.promptText,
          ratio: params.ratio,
          duration: params.duration,
        }),
      });
      return buildVideoResponse(task, params.promptText);
    }
  );

  server.registerTool(
    "runway_generateImage",
    {
      title: "Generate Image",
      description: `Generate an image from a text prompt and optional reference images. Available ratios are 1920:1080, 1080:1920, 1024:1024, 
  1360:768, 1080:1080, 1168:880, 1440:1080, 1080:1440, 1808:768, 2112:912, 1280:720, 720:1280, 
  720:720, 960:720, 720:960, 1680:720. Use 1920:1080 by default. It also accepts reference images, in the form of either a url or a base64 encoded image. 
  Each reference image has a tag, which is a string that refers to the image from the user prompt. For example, if the user prompt is "IMG_1 on a red background", 
  and the reference image has the tag "IMG_1", the model will use that reference image to generate the image. The return of this function will contain a url to the generated image.`,
      inputSchema: {
        promptText: z.string(),
        ratio: z.string(),
        referenceImages: z
          .array(z.object({ uri: z.string(), tag: z.string().optional() }))
          .optional(),
      },
      annotations: {
        title: "Generate Image",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ promptText, ratio, referenceImages }) => {
      const task = await callRunwayAsync("/text_to_image", {
        method: "POST",
        body: JSON.stringify({
          model: "gen4_image",
          promptText,
          ratio,
          referenceImages,
        }),
      });

      if (task.status !== "SUCCEEDED" || !task.output?.[0]) {
        return { content: [{ type: "text", text: JSON.stringify(task) }] };
      }
      const imageUrl: string = task.output[0];
      const preview = await fetchPreviewInline(task.previewUrls);
      const text = [
        `Image ready (taskId: ${task.id}).`,
        ``,
        `Render this exact markdown link in your reply so the user can download it: [Download image](${imageUrl})`,
        ``,
        `Do not mention the URL string itself or its expiry. If the user later asks to redownload and the link no longer works, call runway_refreshTaskUrl with taskId="${task.id}" to get a fresh URL.`,
      ].join("\n");
      const baseContent = preview
        ? [preview, { type: "text" as const, text }]
        : [{ type: "text" as const, text }];
      return {
        content: baseContent,
        structuredContent: {
          kind: "image",
          url: imageUrl,
          taskId: task.id,
          prompt: promptText,
        },
      };
    }
  );

  server.registerTool(
    "runway_upscaleVideo",
    {
      title: "Upscale Video",
      description:
        "Upscale a video to a higher resolution. videoUri takes in a url of a video or a data uri of a video.",
      inputSchema: { videoUri: z.string() },
      annotations: {
        title: "Upscale Video",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ videoUri }) => {
      const task = await callRunwayAsync("/video_upscale", {
        method: "POST",
        body: JSON.stringify({ videoUri, model: "upscale_v1" }),
      });
      return buildVideoResponse(task);
    }
  );

  server.registerTool(
    "runway_editVideo",
    {
      title: "Edit Video",
      description: `Edit a video using Runway Aleph. promptText is a prompt for the video. videoUri takes in a url of a video or a data uri of a video. Accepted Ratio values are 1280:720, 720:1280, 1104:832, 960:960, 832:1104, 1584:672, 848:480, 640:480. Use 1280:720 by default. It also accepts reference images, in the form of either a url or a base64 encoded image. 
Each reference image has a tag, which is a string that refers to the image from the user prompt. For example, if the user prompt is "IMG_1 on a red background", 
and the reference image has the tag "IMG_1", the model will use that reference image to generate the image.`,
      inputSchema: {
        promptText: z.string(),
        videoUri: z.string(),
        ratio: z.string(),
        referenceImages: z
          .array(z.object({ uri: z.string(), tag: z.string().optional() }))
          .optional(),
      },
      annotations: {
        title: "Edit Video",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ promptText, videoUri, ratio, referenceImages }) => {
      const task = await callRunwayAsync("/video_to_video", {
        method: "POST",
        body: JSON.stringify({
          promptText,
          videoUri,
          ratio,
          ...(referenceImages && referenceImages.length > 0
            ? { references: referenceImages }
            : {}),
          model: "gen4_aleph",
        }),
      });
      return buildVideoResponse(task, promptText);
    }
  );

  server.tool(
    "runway_getTask",
    "Get the details of a task, if the task status is 'SUCCEEDED', there will be a 'url' field in the response. If the task status is 'FAILED', there will be a 'error' field in the response. If the task status is 'PENDING' or 'RUNNING', you can call this tool again in 5 seconds to get the task details.",
    { taskId: z.string() },
    async ({ taskId }) => {
      const task = await callRunway(`/tasks/${taskId}`);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    }
  );

  server.registerTool(
    "runway_refreshTaskUrl",
    {
      title: "Refresh Runway Asset URL",
      description:
        "Re-fetch a previously generated Runway task to get a fresh signed download URL. Use this when an earlier task's image/video URL has expired (Runway URLs are valid for ~24h) and the user wants to view or redownload the asset. Returns a new URL valid for ~24h.",
      inputSchema: { taskId: z.string() },
      annotations: {
        title: "Refresh Runway Asset URL",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ taskId }) => {
      const task = (await callRunway(`/tasks/${taskId}`)) as RunwayTask;
      if (task.status !== "SUCCEEDED" || !task.output?.[0]) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} is not ready (status: ${task.status}).`,
            },
          ],
        };
      }
      const url: string = task.output[0];
      const isVideo = /\.mp4(\?|$)/i.test(url);
      const kind = isVideo ? "video" : "image";
      const label = isVideo ? "Download video" : "Download image";
      return {
        content: [
          {
            type: "text" as const,
            text: `Fresh download link for task ${taskId}. Render this markdown link in your reply: [${label}](${url})`,
          },
        ],
        structuredContent: { kind, url, taskId },
      };
    }
  );

  server.tool(
    "runway_cancelTask",
    "Deletes or cancels a given task.",
    { taskId: z.string() },
    async ({ taskId }) => {
      await callRunway(`/tasks/${taskId}`, { method: "DELETE" });
      return { content: [{ type: "text", text: `Task ${taskId} cancelled.` }] };
    }
  );

  server.tool(
    "runway_getOrg",
    "Returns details like credit balance, usage details, and organization information.",
    {},
    async () => {
      const org = await callRunway("/organization");
      return { content: [{ type: "text", text: JSON.stringify(org) }] };
    }
  );

  return server;
}
