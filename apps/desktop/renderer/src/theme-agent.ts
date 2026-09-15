import { type ColorTokenValues, type ThemeConfig, type ThemeMode } from "./theme-config";
import { validateThemeConfig, type ThemeValidationIssue } from "./theme-validation";

export interface ThemeGenerationRequest { prompt: string; baseTheme: ThemeConfig; mode: ThemeMode; }
/** Outcome carries catalog keys rather than prose — see theme-validation.ts. */
export interface ThemeGenerationResult {
  success: boolean;
  theme?: ColorTokenValues;
  errors?: ThemeValidationIssue[];
  warnings?: ThemeValidationIssue[];
}

export async function generateThemeFromPrompt(request: ThemeGenerationRequest): Promise<ThemeGenerationResult> {
  return { success: false, errors: [{ key: "theme.agent.notIntegrated" }] };
}

export function validateGeneratedTheme(theme: unknown, mode: ThemeMode): ThemeGenerationResult {
  const validation = validateThemeConfig(theme);
  if (!validation.valid) return { success: false, errors: validation.errors, warnings: validation.warnings };
  const config = theme as ThemeConfig;
  // Must follow the requested mode: dark-mode generation returning the light half
  // would apply light values to a dark palette.
  return { success: true, theme: config[mode], warnings: validation.warnings };
}
