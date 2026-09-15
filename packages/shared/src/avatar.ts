/** Request/response contract for one transparent employee portrait. */
export interface AvatarGenerateRequest {
  /** Employee name and role context, never a free-form image prompt. */
  brief: string;
}

export interface AvatarGenerateResponse {
  /** PNG data URL so the local renderer never needs a remote image origin. */
  imageDataUrl: string;
}
