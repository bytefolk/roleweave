import { useCallback, useState } from "react";
import { useT } from "@roleweave/ui";
import { useTheme } from "./theme-context";
import { type ThemeGenerationResult } from "./theme-agent";
import { getContrastWarnings, type ContrastWarning } from "./theme-validation";

export function ThemeAgentPrompt() {
  const t = useT();
  const { mode, setCustom } = useTheme();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ThemeGenerationResult | null>(null);
  const [contrastWarnings, setContrastWarnings] = useState<ContrastWarning[]>([]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;
    setLoading(true); setResult(null); setContrastWarnings([]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setResult({ success: false, error: t("theme.agent.notIntegrated") });
    } catch (error) {
      setResult({ success: false, error: error instanceof Error ? error.message : t("theme.agent.unknownError") });
    } finally { setLoading(false); }
  }, [prompt, t]);

  const handleApply = useCallback(() => {
    if (result?.success && result.theme) {
      const warnings = getContrastWarnings(result.theme);
      setContrastWarnings(warnings);
      setCustom({ [mode]: result.theme });
    }
  }, [result, mode, setCustom]);

  const handleCancel = useCallback(() => { setResult(null); setContrastWarnings([]); }, []);

  return (
    <div className="owb-theme-agent">
      <div className="owb-theme-agent__input">
        <label htmlFor="theme-agent-prompt">{t("theme.agent.promptLabel")}</label>
        <textarea id="theme-agent-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("theme.agent.promptPlaceholder")} rows={4} className="owb-theme-agent__textarea" />
        <button type="button" onClick={handleGenerate} disabled={loading || !prompt.trim()} className="owb-theme-agent__generate">{loading ? t("theme.agent.generating") : t("theme.agent.generate")}</button>
      </div>
      {result && (
        <div className="owb-theme-agent__result">
          {result.success ? (
            <>
              <p className="owb-theme-agent__success">{t("theme.agent.success")}</p>
              {contrastWarnings.length > 0 && (
                <div className="owb-theme-agent__warnings">
                  <h4>{t("theme.agent.contrastWarnings")}</h4>
                  <ul>{contrastWarnings.map((warning, i) => <li key={i}>{t("theme.agent.contrastWarning", { foreground: warning.foreground, background: warning.background, ratio: warning.ratio.toString(), required: warning.required.toString() })}</li>)}</ul>
                </div>
              )}
              <div className="owb-theme-agent__actions">
                <button type="button" onClick={handleApply}>{t("theme.agent.apply")}</button>
                <button type="button" onClick={handleCancel}>{t("theme.agent.cancel")}</button>
              </div>
            </>
          ) : <p className="owb-theme-agent__error">{result.error}</p>}
        </div>
      )}
    </div>
  );
}
