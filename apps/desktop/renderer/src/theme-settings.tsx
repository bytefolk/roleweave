import { useCallback, useEffect, useState } from "react";
import { useT } from "@roleweave/ui";
import { BUILT_IN_PRESETS } from "./theme-presets";
import { useTheme } from "./theme-context";
import { ThemePicker } from "./theme-picker";

type TabId = "preset" | "custom";

export function ThemeSettings({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const { presetId, custom, setPreset, setCustom, reset, save, isDirty } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("preset");
  useEffect(() => () => setCustom(null), [setCustom]);
  // `setPreset` persists at once and drops the saved custom colours, so that
  // loss has to be an explicit choice instead of a side effect of browsing.
  const handlePresetSelect = useCallback((id: string) => {
    if (id === presetId) return;
    if (custom && !window.confirm(t("theme.settings.presetConfirm"))) return;
    setPreset(id);
  }, [presetId, custom, setPreset, t]);
  const handleReset = useCallback(() => { if (window.confirm(t("theme.settings.resetConfirm"))) reset(); }, [reset, t]);
  const handleSave = useCallback(() => { save(); onClose?.(); }, [save, onClose]);
  const handleCancel = useCallback(() => { setCustom(null); onClose?.(); }, [setCustom, onClose]);

  return (
    <div className={`owb-theme-settings${onClose ? "" : " owb-theme-settings--inline"}`}>
      <header className="owb-theme-settings__header">
        <h2>{t("theme.settings.title")}</h2>
        {onClose ? <button type="button" onClick={handleCancel} className="owb-theme-settings__close">{t("dlg.close")}</button> : null}
      </header>
      <nav className="owb-theme-settings__tabs">
        <button type="button" className={activeTab === "preset" ? "active" : ""} onClick={() => setActiveTab("preset")}>{t("theme.settings.tabPreset")}</button>
        <button type="button" className={activeTab === "custom" ? "active" : ""} onClick={() => setActiveTab("custom")}>{t("theme.settings.tabCustom")}</button>
      </nav>
      <div className="owb-theme-settings__content">
        {activeTab === "preset" && (
          <div className="owb-theme-settings__presets">
            <p className="owb-theme-settings__hint">{t("theme.settings.presetHint")}</p>
            <div className="owb-theme-settings__preset-list">
              {BUILT_IN_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={`owb-theme-settings__preset ${presetId === preset.id ? "active" : ""}`} onClick={() => handlePresetSelect(preset.id)}>
                  <span className="owb-theme-settings__preset-name">{t(preset.nameKey)}</span>
                  <span className="owb-theme-settings__preset-desc">{t(preset.descriptionKey)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {activeTab === "custom" && (<div className="owb-theme-settings__custom"><p className="owb-theme-settings__hint">{t("theme.settings.customHint")}</p><ThemePicker /></div>)}
      </div>
      <footer className="owb-theme-settings__footer">
        <button type="button" onClick={handleReset} className="owb-theme-settings__reset">{t("theme.settings.reset")}</button>
        <div className="owb-theme-settings__actions">
          <button type="button" disabled={!onClose && !isDirty} className="owb-theme-settings__cancel" onClick={handleCancel}>{t("dlg.cancel")}</button>
          <button type="button" onClick={handleSave} disabled={!isDirty} className="owb-theme-settings__save">{t("theme.settings.save")}</button>
        </div>
      </footer>
    </div>
  );
}
