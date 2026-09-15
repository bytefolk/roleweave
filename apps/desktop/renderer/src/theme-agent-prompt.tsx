import { useCallback, useState } from "react";
import { useT } from "@roleweave/ui";
import { useTheme } from "./theme-context";
import { type ThemeGenerationResult } from "./theme-agent";
import { ContrastWarningsView } from "./theme-picker";

export function ThemeAgentPrompt() {
  const t = useT();
  const { mode, setCustom } = useTheme();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<ThemeGenerationResult | null>(null);

  // `generateThemeFromPrompt` is a stub that resolves with a failure, so it can
  // neither reject nor succeed: the old try/catch was unreachable and the 1s
  // delay only stalled the panel. Report the outcome immediately.
  const handleGenerate = useCallback(() => {
    if (!prompt.trim()) return;
    setResult({ success: false, errors: [{ key: "theme.agent.notIntegrated" }] });
  }, [prompt]);

  const handleApply = useCallback(() => {
    if (!result?.success || !result.theme) return;
    // Keep the shape explicit: a computed `{ [mode]: theme }` widens to an index
    // signature that `CustomThemeOverrides` does not accept.
    setCustom(mode === "light" ? { light: result.theme } : { dark: result.theme });
  }, [result, mode, setCustom]);

  const handleCancel = useCallback(() => { setResult(null); }, []);

  return (
    <div className="owb-theme-agent">
      <div className="owb-theme-agent__input">
        <label htmlFor="theme-agent-prompt">{t("theme.agent.promptLabel")}</label>
        <textarea id="theme-agent-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("theme.agent.promptPlaceholder")} rows={4} className="owb-theme-agent__textarea" />
        <button type="button" onClick={handleGenerate} disabled={!prompt.trim()} className="owb-theme-agent__generate">{t("theme.agent.generate")}</button>
      </div>
      {result && (
        <div className="owb-theme-agent__result">
          {result.success && result.theme ? (
            <>
              <p className="owb-theme-agent__success">{t("theme.agent.success")}</p>
              <ContrastWarningsView theme={result.theme} title={t("theme.settings.contrastWarnings")} />
              <div className="owb-theme-agent__actions">
                <button type="button" className="owb-theme-agent__apply" onClick={handleApply}>{t("theme.agent.apply")}</button>
                <button type="button" className="owb-theme-agent__cancel" onClick={handleCancel}>{t("theme.agent.cancel")}</button>
              </div>
            </>
          ) : <p className="owb-theme-agent__error">{(result.errors ?? []).map((issue) => t(issue.key, issue.vars)).join("; ")}</p>}
        </div>
      )}
    </div>
  );
}
