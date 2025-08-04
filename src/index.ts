import "dotenv/config";
import fetch, { RequestInit } from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const API_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";
const SECRET = process.env.RUNWAYML_API_SECRET!;

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
  [key: string]: any; // for other task-specific fields
}

const server = new McpServer({ name: "Runway", version: "1.0.0" });

async function callRunway(
  path: string,
  opts: Partial<RequestInit> = {}
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${SECRET}`,
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
    // Wait 5 seconds before next poll
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function callRunwayAsync(
  path: string,
  opts: Partial<RequestInit> = {}
): Promise<RunwayTask> {
  const response = (await callRunway(path, opts)) as {
    id?: string;
  } & RunwayTask;
  // If the response has a taskId, wait for completion
  if (response?.id) {
    return waitForTaskCompletion(response.id);
  }
  // If no taskId, just return the response as is
  return response;
}

// 1. Generate video from image
server.tool(
  "runway_generateVideo",
  "Generate a video from an image and a text prompt. Accepted ratios are 1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672. Use 1280:720 by default. For duration, there are only either 5 or 10 seconds. Use 5 seconds by default. If the user asks to generate a video, always first use generateImage to generate an image first, then use the image to generate a video.",
  {
    promptImage: z.string(),
    promptText: z.string().optional(),
    ratio: z.string(),
    duration: z.number(),
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
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 2. Generate image from text
server.tool(
  "runway_generateImage",
  `Generate an image from a text prompt and optional reference images. Available ratios are 1920:1080, 1080:1920, 1024:1024, 
  1360:768, 1080:1080, 1168:880, 1440:1080, 1080:1440, 1808:768, 2112:912, 1280:720, 720:1280, 
  720:720, 960:720, 720:960, 1680:720. Use 1920:1080 by default. It also accepts reference images, in the form of either a url or a base64 encoded image. 
  Each reference image has a tag, which is a string that refers to the image from the user prompt. For example, if the user prompt is "IMG_1 on a red background", 
  and the reference image has the tag "IMG_1", the model will use that reference image to generate the image. The return of this function will contain a url to the generated image.`,
  {
    promptText: z.string(),
    ratio: z.string(),
    referenceImages: z
      .array(z.object({ uri: z.string(), tag: z.string().optional() }))
      .optional(),
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

    if (task.status === "SUCCEEDED") {
      return {
        content: [
          {
            type: "text",
            text: `Here is the URL of the image: ${task.output[0]}. Return to the user, as a markdown link, the URL of the image and the prompt that was used to generate the image.`,
          },
        ],
      };
    } else {
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    }
  }
);

// 3. Upscale a video
server.tool(
  "runway_upscaleVideo",
  "Upscale a video to a higher resolution. videoUri takes in a url of a video or a data uri of a video.",
  { videoUri: z.string() },
  async ({ videoUri }) => {
    const task = await callRunwayAsync("/video_upscale", {
      method: "POST",
      body: JSON.stringify({ videoUri, model: "upscale_v1" }),
    });
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 4. Edit a video
server.tool(
  "runway_editVideo",
  `Edit a video using Runway Aleph. promptText is a prompt for the video. videoUri takes in a url of a video or a data uri of a video. Accepted Ratio values are 1280:720, 720:1280, 1104:832, 960:960, 832:1104, 1584:672, 848:480, 640:480. Use 1280:720 by default. It also accepts reference images, in the form of either a url or a base64 encoded image. 
Each reference image has a tag, which is a string that refers to the image from the user prompt. For example, if the user prompt is "IMG_1 on a red background", 
and the reference image has the tag "IMG_1", the model will use that reference image to generate the image.`,
  {
    promptText: z.string(),
    videoUri: z.string(),
    ratio: z.string(),
    referenceImages: z
      .array(z.object({ uri: z.string(), tag: z.string().optional() }))
      .optional(),
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
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 5. Get task detail
server.tool(
  "runway_getTask",
  "Get the details of a task, if the task status is 'SUCCEEDED', there will be a 'url' field in the response. If the task status is 'FAILED', there will be a 'error' field in the response. If the task status is 'PENDING' or 'RUNNING', you can call this tool again in 5 seconds to get the task details.",
  {
    taskId: z.string(),
  },
  async ({ taskId }) => {
    const task = await callRunway(`/tasks/${taskId}`);
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 6. Cancel/delete a task
server.tool(
  "runway_cancelTask",
  "Deletes or cancels a given task.",
  { taskId: z.string() },
  async ({ taskId }) => {
    await callRunway(`/tasks/${taskId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Task ${taskId} cancelled.` }] };
  }
);

// 7. Get organization info
server.tool(
  "runway_getOrg",
  "Returns details like credit balance, usage details, and organization information.",
  {},
  async () => {
    const org = await callRunway("/organization");
    return { content: [{ type: "text", text: JSON.stringify(org) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Runway MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
