import { useCallback, useState } from "react";
import { useT } from "@roleweave/ui";
import { BUILT_IN_PRESETS } from "./theme-presets";
import { useTheme } from "./theme-context";
import { ThemePicker } from "./theme-picker";
import { ThemeAgentPrompt } from "./theme-agent-prompt";

type TabId = "preset" | "custom" | "agent";

export function ThemeSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { presetId, setPreset, reset, save, isDirty } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("preset");
  const handlePresetSelect = useCallback((id: string) => { setPreset(id); }, [setPreset]);
  const handleReset = useCallback(() => { if (window.confirm(t("theme.settings.resetConfirm"))) reset(); }, [reset, t]);
  const handleSave = useCallback(() => { save(); onClose(); }, [save, onClose]);
  const handleCancel = useCallback(() => { onClose(); }, [onClose]);

  return (
    <div className="owb-theme-settings">
      <header className="owb-theme-settings__header">
        <h2>{t("theme.settings.title")}</h2>
        <button type="button" onClick={onClose} className="owb-theme-settings__close">{t("dlg.close")}</button>
      </header>
      <nav className="owb-theme-settings__tabs">
        <button type="button" className={activeTab === "preset" ? "active" : ""} onClick={() => setActiveTab("preset")}>{t("theme.settings.tabPreset")}</button>
        <button type="button" className={activeTab === "custom" ? "active" : ""} onClick={() => setActiveTab("custom")}>{t("theme.settings.tabCustom")}</button>
        <button type="button" className={activeTab === "agent" ? "active" : ""} onClick={() => setActiveTab("agent")}>{t("theme.settings.tabAgent")}</button>
      </nav>
      <div className="owb-theme-settings__content">
        {activeTab === "preset" && (
          <div className="owb-theme-settings__presets">
            <p className="owb-theme-settings__hint">{t("theme.settings.presetHint")}</p>
            <div className="owb-theme-settings__preset-list">
              {BUILT_IN_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={`owb-theme-settings__preset ${presetId === preset.id ? "active" : ""}`} onClick={() => handlePresetSelect(preset.id)}>
                  <span className="owb-theme-settings__preset-name">{preset.name}</span>
                  <span className="owb-theme-settings__preset-desc">{preset.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {activeTab === "custom" && (<div className="owb-theme-settings__custom"><p className="owb-theme-settings__hint">{t("theme.settings.customHint")}</p><ThemePicker /></div>)}
        {activeTab === "agent" && (<div className="owb-theme-settings__agent"><p className="owb-theme-settings__hint">{t("theme.settings.agentHint")}</p><ThemeAgentPrompt /></div>)}
      </div>
      <footer className="owb-theme-settings__footer">
        <button type="button" onClick={handleReset} className="owb-theme-settings__reset">{t("theme.settings.reset")}</button>
        <div className="owb-theme-settings__actions">
          <button type="button" onClick={handleCancel}>{t("dlg.cancel")}</button>
          <button type="button" onClick={handleSave} disabled={!isDirty} className="owb-theme-settings__save">{t("theme.settings.save")}</button>
        </div>
      </footer>
    </div>
  );
}
