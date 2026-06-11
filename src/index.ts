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
const VIDEO_MODELS = [
  "gen3a_turbo", "gen4_turbo", "gen4", "gen4.5",
  "kling2.5_turbo_pro", "kling3.0_pro", "kling3.0_4k", "kling3.0_standard",
  "klingO3_pro", "klingO3_standard", "klingO3_4k",
  "veo3", "veo3.1", "veo3.1_fast",
  "seedance2", "seedance2_fast",
] as const;
server.tool(
  "runway_generateVideo",
  `Generate a video from an image and a text prompt. Default model is gen4_turbo (ratios 1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672; duration 5 or 10).
Other models: seedance2 / seedance2_fast (ByteDance Seedance 2.0 — duration 4-15s, ratios include 1920:1080, 1280:720, 720:1280, 960:960, 1470:630, 2206:946; supports audio:true for native sound and lip-synced dialogue — put spoken lines in quotes inside promptText), veo3/veo3.1 (native audio), kling3.0 and gen4.5 families.
If the user asks to generate a video, first use runway_generateImage to create a keyframe, then animate it.`,
  {
    promptImage: z.string(),
    promptText: z.string().optional(),
    ratio: z.string(),
    duration: z.number(),
    model: z.enum(VIDEO_MODELS).optional(),
    audio: z
      .boolean()
      .optional()
      .describe("Generate native audio (seedance2, veo3 family)"),
  },
  async (params) => {
    const task = await callRunwayAsync("/image_to_video", {
      method: "POST",
      body: JSON.stringify({
        model: params.model ?? "gen4_turbo",
        promptImage: params.promptImage,
        promptText: params.promptText,
        ratio: params.ratio,
        duration: params.duration,
        ...(params.audio !== undefined ? { audio: params.audio } : {}),
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
    model: z
      .enum([
        "gen4_image",
        "gen4_image_turbo",
        "gemini_2.5_flash",
        "gemini_image3.1_flash",
        "gemini_image3_pro",
        "gpt_image_2",
      ])
      .optional()
      .describe(
        "Default gen4_image. gemini_image3_pro = Nano Banana 2/Pro, gemini_2.5_flash = Nano Banana 1. NOTE: gemini family uses its own ratio set (e.g. 1344:768, 768:1344, 1024:1024, 2048:2048, 3168:1344) — NOT the gen4 ratios."
      ),
  },
  async ({ promptText, ratio, referenceImages, model }) => {
    const task = await callRunwayAsync("/text_to_image", {
      method: "POST",
      body: JSON.stringify({
        model: model ?? "gen4_image",
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

// 4b. Text to speech (ElevenLabs via Runway)
server.tool(
  "runway_textToSpeech",
  "Generate speech audio from text using ElevenLabs (eleven_multilingual_v2). Use voicePresetId for a Runway preset voice (e.g. 'James'), or list available voices with runway_listVoices and pass a voiceId.",
  {
    promptText: z.string(),
    voicePresetId: z.string().optional(),
    voiceId: z.string().optional(),
  },
  async ({ promptText, voicePresetId, voiceId }) => {
    const voice = voiceId
      ? { type: "id", voiceId }
      : { type: "runway-preset", presetId: voicePresetId ?? "James" };
    const task = await callRunwayAsync("/text_to_speech", {
      method: "POST",
      body: JSON.stringify({ model: "eleven_multilingual_v2", promptText, voice }),
    });
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 4c. Sound effects / music (ElevenLabs via Runway)
server.tool(
  "runway_soundEffect",
  "Generate a sound effect or short music cue from a text description (eleven_text_to_sound_v2). promptDuration is in seconds (max ~22).",
  {
    promptText: z.string(),
    promptDuration: z.number().optional(),
  },
  async ({ promptText, promptDuration }) => {
    const task = await callRunwayAsync("/sound_effect", {
      method: "POST",
      body: JSON.stringify({
        model: "eleven_text_to_sound_v2",
        promptText,
        ...(promptDuration ? { promptDuration } : {}),
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 4d. Avatar video (talking head from speech audio)
server.tool(
  "runway_avatarVideo",
  "Generate a lip-synced talking-avatar video (gwm1_avatars) from a speech audio asset. avatarPresetId is a Runway preset (e.g. 'influencer'); speechAudioUri is a URL or data URI of the speech audio.",
  {
    avatarPresetId: z.string(),
    speechAudioUri: z.string(),
  },
  async ({ avatarPresetId, speechAudioUri }) => {
    const task = await callRunwayAsync("/avatar_videos", {
      method: "POST",
      body: JSON.stringify({
        model: "gwm1_avatars",
        avatar: { type: "runway-preset", presetId: avatarPresetId },
        speech: { type: "audio", audio: speechAudioUri },
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  }
);

// 4e. List available TTS voices
server.tool(
  "runway_listVoices",
  "List available text-to-speech voices (GET /voices).",
  {},
  async () => {
    const voices = await callRunway("/voices");
    return { content: [{ type: "text", text: JSON.stringify(voices) }] };
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
