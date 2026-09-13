import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OrgApiError,
  errorCodes,
  type AvatarGenerateRequest,
  type AvatarGenerateResponse,
} from "@roleweave/shared";
import { readJsonBody, sendJson } from "../http.js";

const MAX_BRIEF_LENGTH = 320;
const IMAGE_API_URL = "https://api.openai.com/v1/images/generations";

function normalizedBrief(value: unknown): string {
  if (typeof value !== "string") {
    throw new OrgApiError(errorCodes.avatar_request_invalid, 400, "brief must be a string");
  }
  const brief = value.replace(/\s+/g, " ").trim();
  if (brief.length < 2 || brief.length > MAX_BRIEF_LENGTH) {
    throw new OrgApiError(
      errorCodes.avatar_request_invalid,
      400,
      `brief must be between 2 and ${MAX_BRIEF_LENGTH} characters`,
    );
  }
  return brief;
}

function avatarPrompt(brief: string): string {
  return [
    "Create one polished head-and-shoulders portrait avatar for a digital employee.",
    "The image must be a clean transparent-background cutout: no backdrop, scene, gradient, shape, frame, text, logo, badge, or watermark.",
    "Use a warm, natural editorial illustration style with believable facial detail and varied features; keep the shoulders visible and centered.",
    `Employee context: ${brief}`,
  ].join(" ");
}

/** POST /avatar/generate — keeps the image-provider key out of Electron. */
export async function handleAvatarGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<AvatarGenerateRequest>(req);
  const brief = normalizedBrief(body?.brief);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new OrgApiError(
      errorCodes.avatar_generation_unavailable,
      503,
      "AI avatar generation is not configured; set OPENAI_API_KEY or upload an image instead",
      false,
    );
  }

  let response: Response;
  try {
    response = await fetch(IMAGE_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: avatarPrompt(brief),
        size: "1024x1024",
        background: "transparent",
        output_format: "png",
        n: 1,
      }),
      signal: AbortSignal.timeout(75_000),
    });
  } catch {
    throw new OrgApiError(errorCodes.avatar_generation_unavailable, 503, "AI avatar generation is temporarily unavailable", true);
  }
  if (!response.ok) {
    throw new OrgApiError(errorCodes.avatar_generation_unavailable, 503, "AI avatar generation could not be completed", true);
  }
  const result = await response.json() as { data?: Array<{ b64_json?: unknown }> };
  const image = result.data?.[0]?.b64_json;
  if (typeof image !== "string" || image.length === 0) {
    throw new OrgApiError(errorCodes.avatar_generation_unavailable, 503, "AI avatar generation returned no image", true);
  }
  const payload: AvatarGenerateResponse = { imageDataUrl: `data:image/png;base64,${image}` };
  sendJson(res, 200, payload);
}
