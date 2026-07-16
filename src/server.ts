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

interface ModelSpec {
  id: string;
  required: string[];
  params: Record<string, string[] | number[] | { min?: number; max?: number }>;
}

interface ModelCatalogEntry {
  capability: string;
  endpoint: string;
  recommended: string;
  alias?: string;
  models: ModelSpec[];
}

// Model catalog derived from the Runway OpenAPI spec (github.com/runwayml/openapi, next branch).
// Each model lists its own valid parameter values, since ratios/durations/etc. are model-specific.
const MODELS: readonly ModelCatalogEntry[] = [
  {
    capability: "textToImage",
    endpoint: "/v1/text_to_image",
    recommended: "gemini_image3_pro",
    alias: "Nano Banana Pro",
    models: [
      {
        id: "gen4_image",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["1024:1024", "1080:1080", "1168:880", "1360:768", "1440:1080", "1080:1440", "1808:768", "1920:1080", "1080:1920", "2112:912", "1280:720", "720:1280", "720:720", "960:720", "720:960", "1680:720"],
        },
      },
      {
        id: "gen4_image_turbo",
        required: ["promptText", "ratio", "referenceImages"],
        params: {
          "ratio": ["1024:1024", "1080:1080", "1168:880", "1360:768", "1440:1080", "1080:1440", "1808:768", "1920:1080", "1080:1920", "2112:912", "1280:720", "720:1280", "720:720", "960:720", "720:960", "1680:720"],
        },
      },
      {
        id: "gpt_image_2",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["2048:880", "1920:1088", "1920:1280", "1920:1440", "1920:1536", "1920:1920", "1536:1920", "1440:1920", "1280:1920", "1088:1920", "2912:1248", "2560:1440", "2560:1712", "2560:1920", "2560:2048", "2560:2560", "2048:2560", "1920:2560", "1712:2560", "1440:2560", "3840:1648", "3840:2160", "3504:2336", "3264:2448", "3200:2560", "2880:2880", "2560:3200", "2448:3264", "2336:3504", "2160:3840", "auto"],
          "quality": ["low", "medium", "high", "auto"],
          "background": ["opaque", "auto"],
          "outputCount": {"min": 1, "max": 10},
        },
      },
      {
        id: "gemini_image3_pro",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["1344:768", "768:1344", "1024:1024", "1184:864", "864:1184", "1536:672", "832:1248", "1248:832", "896:1152", "1152:896", "2048:2048", "1696:2528", "2528:1696", "1792:2400", "2400:1792", "1856:2304", "2304:1856", "1536:2752", "2752:1536", "3168:1344", "4096:4096", "3392:5056", "5056:3392", "3584:4800", "4800:3584", "3712:4608", "4608:3712", "3072:5504", "5504:3072", "6336:2688"],
          "outputCount": [1, 4],
        },
      },
      {
        id: "gemini_image3.1_flash",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["512:512", "416:624", "624:416", "432:592", "592:432", "448:576", "576:448", "384:672", "672:384", "768:336", "256:1024", "1024:256", "176:1408", "1408:176", "1024:1024", "832:1248", "1248:832", "864:1184", "1184:864", "896:1152", "1152:896", "768:1344", "1344:768", "1536:672", "512:2048", "2048:512", "352:2816", "2816:352", "2048:2048", "1696:2528", "2528:1696", "1792:2400", "2400:1792", "1856:2304", "2304:1856", "1536:2752", "2752:1536", "3168:1344", "1024:4096", "4096:1024", "704:5632", "5632:704", "4096:4096", "3392:5056", "5056:3392", "3584:4800", "4800:3584", "3712:4608", "4608:3712", "3072:5504", "5504:3072", "6336:2688", "2048:8192", "8192:2048", "1408:11264", "11264:1408"],
          "outputCount": [1, 4],
        },
      },
      {
        id: "gemini_2.5_flash",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["1344:768", "768:1344", "1024:1024", "1184:864", "864:1184", "1536:672", "832:1248", "1248:832", "896:1152", "1152:896"],
        },
      },
      {
        id: "seedream5_pro",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["1024:1024", "1184:896", "896:1184", "1376:768", "768:1376", "1296:864", "864:1296", "2048:2048", "2304:1728", "1728:2304", "2720:1530", "1530:2720", "2496:1664", "1664:2496", "auto_1k", "auto_2k"],
          "outputFormat": ["png", "jpeg"],
          "outputCount": {"min": 1, "max": 4},
        },
      },
      {
        id: "seedream5_lite",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["2048:2048", "2304:1728", "1728:2304", "2848:1600", "1600:2848", "2496:1664", "1664:2496", "3136:1344", "3072:3072", "3456:2592", "2592:3456", "4096:2304", "2304:4096", "3744:2496", "2496:3744", "4704:2016"],
          "outputFormat": ["png", "jpeg"],
          "outputCount": {"min": 1, "max": 4},
        },
      },
    ],
  },
  {
    capability: "imageToVideo",
    endpoint: "/v1/image_to_video",
    recommended: "seedance2",
    alias: "Seedance",
    models: [
      {
        id: "seedance2",
        required: ["promptImage"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280", "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920", "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840"],
        },
      },
      {
        id: "seedance2_fast",
        required: ["promptImage"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
        },
      },
      {
        id: "seedance2_mini",
        required: ["promptImage"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
        },
      },
      {
        id: "gen4.5",
        required: ["promptText", "promptImage", "ratio", "duration"],
        params: {
          "ratio": ["1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672"],
          "duration": {"min": 2, "max": 10},
        },
      },
      {
        id: "gen4_turbo",
        required: ["promptImage", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1104:832", "832:1104", "960:960", "1584:672"],
          "duration": {"min": 2, "max": 10},
        },
      },
      {
        id: "veo3.1",
        required: ["promptImage", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1080:1920", "1920:1080"],
          "duration": [4, 6, 8],
        },
      },
      {
        id: "veo3.1_fast",
        required: ["promptImage", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1080:1920", "1920:1080"],
          "duration": [4, 6, 8],
        },
      },
      {
        id: "veo3",
        required: ["promptImage", "duration", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1080:1920", "1920:1080"],
        },
      },
    ],
  },
  {
    capability: "textToVideo",
    endpoint: "/v1/text_to_video",
    recommended: "seedance2",
    alias: "Seedance",
    models: [
      {
        id: "seedance2",
        required: ["promptText"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280", "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920", "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840"],
        },
      },
      {
        id: "seedance2_fast",
        required: ["promptText"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
        },
      },
      {
        id: "seedance2_mini",
        required: ["promptText"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
        },
      },
      {
        id: "gen4.5",
        required: ["promptText", "ratio", "duration"],
        params: {
          "ratio": ["1280:720", "720:1280"],
          "duration": {"min": 2, "max": 10},
        },
      },
      {
        id: "veo3.1",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1080:1920", "1920:1080"],
          "duration": [4, 6, 8],
        },
      },
      {
        id: "veo3.1_fast",
        required: ["promptText", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1080:1920", "1920:1080"],
          "duration": [4, 6, 8],
        },
      },
      {
        id: "veo3",
        required: ["promptText", "duration", "ratio"],
        params: {
          "ratio": ["1280:720", "720:1280", "1080:1920", "1920:1080"],
        },
      },
    ],
  },
  {
    capability: "videoToVideo",
    endpoint: "/v1/video_to_video",
    recommended: "aleph2",
    alias: "Aleph",
    models: [
      {
        id: "aleph2",
        required: ["videoUri"],
        params: {
          "targetAspectRatio": ["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "21:9"],
        },
      },
      {
        id: "seedance2",
        required: ["promptVideo"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280", "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920", "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840"],
        },
      },
      {
        id: "seedance2_fast",
        required: ["promptVideo"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
        },
      },
      {
        id: "seedance2_mini",
        required: ["promptVideo"],
        params: {
          "duration": {"min": 4, "max": 15},
          "ratio": ["992:432", "864:496", "752:560", "640:640", "560:752", "496:864", "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280"],
        },
      },
    ],
  },
  {
    capability: "videoUpscale",
    endpoint: "/v1/video_upscale",
    recommended: "magnific_video_upscaler_creative",
    models: [
      {
        id: "magnific_video_upscaler_creative",
        required: ["videoUri"],
        params: {
          "resolution": ["720p", "1k", "2k", "4k"],
          "creativity": {"min": 0, "max": 100},
          "sharpen": {"min": 0, "max": 100},
          "smartGrain": {"min": 0, "max": 100},
          "flavor": ["vivid", "natural"],
        },
      },
    ],
  },
  {
    capability: "imageUpscale",
    endpoint: "/v1/image_upscale",
    recommended: "magnific_precision_upscaler_v2",
    models: [
      {
        id: "magnific_precision_upscaler_v2",
        required: ["imageUri"],
        params: {
          "scaleFactor": [2, 4, 8, 16],
          "sharpen": {"min": 0, "max": 100},
          "smartGrain": {"min": 0, "max": 100},
          "ultraDetail": {"min": 0, "max": 100},
          "flavor": ["sublime", "photo", "photo_denoiser"],
        },
      },
    ],
  },
  {
    capability: "textToSpeech",
    endpoint: "/v1/text_to_speech",
    recommended: "seed_audio",
    models: [
      {
        id: "seed_audio",
        required: ["promptText"],
        params: {
          "speechRate": {"min": -50, "max": 100},
          "loudnessRate": {"min": -50, "max": 100},
          "pitchRate": {"min": -12, "max": 12},
          "sampleRate": [8000, 16000, 24000, 32000, 44100, 48000],
          "outputFormat": ["wav", "mp3", "ogg_opus"],
        },
      },
      { id: "eleven_multilingual_v2", required: ["promptText", "voice"], params: {} },
    ],
  },
  {
    capability: "soundEffect",
    endpoint: "/v1/sound_effect",
    recommended: "seed_audio",
    models: [
      {
        id: "seed_audio",
        required: ["promptText"],
        params: {
          "speechRate": {"min": -50, "max": 100},
          "loudnessRate": {"min": -50, "max": 100},
          "pitchRate": {"min": -12, "max": 12},
          "sampleRate": [8000, 16000, 24000, 32000, 44100, 48000],
          "outputFormat": ["wav", "mp3", "ogg_opus"],
        },
      },
      {
        id: "eleven_text_to_sound_v2",
        required: ["promptText"],
        params: {
          "duration": {"min": 0.5, "max": 30},
        },
      },
    ],
  },
];

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

  server.tool(
    "runway_listModels",
    "Lists the available Runway models for each generation capability (image, video, " +
      "video editing, upscaling, audio), the recommended 'best' model for each, and — per " +
      "model — the exact valid parameter values (e.g. `ratio`, `duration`, `resolution`) and " +
      "which parameters that model requires. Valid ratios and other options differ by model, " +
      "so call this before picking a `ratio`/`duration` for the other tools. Callers should " +
      "use the recommended model unless the user requests a specific one.",
    {},
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(MODELS) }] };
    }
  );

  server.registerTool(
    "runway_generateVideo",
    {
      title: "Generate Video",
      description:
        "Generate a video from an image (image-to-video). The best model is Seedance (`seedance2`), used by default; pass `model` to override. The valid `ratio` and `duration` values depend on the chosen model, so call runway_listModels first to get the exact ratios, duration range, and which parameters that model requires (some models omit `duration` or require a specific `ratio`). If the user asks to generate a video, first use runway_generateImage to create an image, then pass it here as `promptImage`.",
      inputSchema: {
        promptImage: z.string(),
        promptText: z.string().optional(),
        ratio: z.string().optional(),
        duration: z.number().optional(),
        model: z.string().optional(),
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
          model: params.model ?? "seedance2",
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
      description: `Generate an image from a text prompt and optional reference images. The best model for text/image-to-image is Nano Banana Pro (\`gemini_image3_pro\`), used by default; pass \`model\` to override. The valid \`ratio\` values depend on the chosen model, so call runway_listModels first to get the exact ratios each model supports (they vary widely). Reference images are provided as a url or a base64 data uri, each with a \`tag\` string that is referenced from the prompt. For example, if the user prompt is "IMG_1 on a red background" and the reference image has the tag "IMG_1", the model will use that reference image. The return of this function will contain a url to the generated image.`,
      inputSchema: {
        promptText: z.string(),
        ratio: z.string(),
        referenceImages: z
          .array(z.object({ uri: z.string(), tag: z.string().optional() }))
          .optional(),
        model: z.string().optional(),
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
    async ({ promptText, ratio, referenceImages, model }) => {
      const task = await callRunwayAsync("/text_to_image", {
        method: "POST",
        body: JSON.stringify({
          model: model ?? "gemini_image3_pro",
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
        "Upscale a video to a higher resolution. videoUri takes in a url of a video or a " +
        "data uri of a video. Uses the Magnific video upscaler by default; pass `model` " +
        "to override.",
      inputSchema: { videoUri: z.string(), model: z.string().optional() },
      annotations: {
        title: "Upscale Video",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ videoUri, model }) => {
      const task = await callRunwayAsync("/video_upscale", {
        method: "POST",
        body: JSON.stringify({
          videoUri,
          model: model ?? "magnific_video_upscaler_creative",
        }),
      });
      return buildVideoResponse(task);
    }
  );

  server.registerTool(
    "runway_editVideo",
    {
      title: "Edit Video",
      description: `Edit a video (video-to-video) using Runway Aleph. \`promptText\` describes the edit; \`videoUri\` is a url or data uri of the source video. The best model is Aleph (\`aleph2\`), used by default; pass \`model\` to override. The valid \`ratio\` values depend on the chosen model, so call runway_listModels first (Aleph also accepts a \`targetAspectRatio\` such as "16:9"). Reference images are provided as a url or base64 data uri, each with a \`tag\` referenced from the prompt (e.g. prompt "IMG_1 on a red background" with a reference image tagged "IMG_1"). Note: reference images are only supported by the legacy \`gen4_aleph\` model — pass \`model\`: "gen4_aleph" when providing referenceImages.`,
      inputSchema: {
        promptText: z.string(),
        videoUri: z.string(),
        ratio: z.string().optional(),
        referenceImages: z
          .array(z.object({ uri: z.string(), tag: z.string().optional() }))
          .optional(),
        model: z.string().optional(),
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
    async ({ promptText, videoUri, ratio, referenceImages, model }) => {
      const task = await callRunwayAsync("/video_to_video", {
        method: "POST",
        body: JSON.stringify({
          promptText,
          videoUri,
          ratio,
          ...(referenceImages && referenceImages.length > 0
            ? { references: referenceImages }
            : {}),
          model: model ?? "aleph2",
        }),
      });
      return buildVideoResponse(task, promptText);
    }
  );

  server.tool(
    "runway_generateAudio",
    "Generate spoken audio (text-to-speech) from text. The default model is `seed_audio` " +
      "(ByteDance's Seed audio model, which uses a default voice if none is given); " +
      "`eleven_multilingual_v2` (ElevenLabs) is also available but requires a `voice`. " +
      "Optionally pass a `voice` object. Call runway_listModels to see all audio models.",
    {
      promptText: z.string(),
      voice: z.any().optional(),
      model: z.string().optional(),
    },
    async ({ promptText, voice, model }) => {
      const task = await callRunwayAsync("/text_to_speech", {
        method: "POST",
        body: JSON.stringify({
          model: model ?? "seed_audio",
          promptText,
          ...(voice ? { voice } : {}),
        }),
      });

      if (task.output) {
        return {
          content: [
            {
              type: "text",
              text: `Here is the URL of the audio: ${task.output[0]}. Return to the user, as a markdown link, the URL of the audio and the prompt that was used to generate it.`,
            },
          ],
        };
      } else {
        return { content: [{ type: "text", text: JSON.stringify(task) }] };
      }
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
