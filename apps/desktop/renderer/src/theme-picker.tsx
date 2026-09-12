import { useCallback, useState } from "react";
import { useT } from "@roleweave/ui";
import { COLOR_TOKEN_KEYS, type ColorTokenKey, type ThemeMode } from "./theme-config";
import { useTheme } from "./theme-context";
import { isValidColorValue } from "./theme-validation";

interface ColorGroup { label: string; keys: ColorTokenKey[]; }
const COLOR_GROUPS: ColorGroup[] = [
  { label: "surface", keys: ["canvas", "canvas-subtle", "navigation", "navigation-hover", "surface", "surface-raised", "surface-inset"] },
  { label: "foreground", keys: ["foreground", "foreground-muted", "foreground-subtle"] },
  { label: "border", keys: ["border", "border-strong"] },
  { label: "primary", keys: ["primary", "primary-hover", "primary-foreground", "primary-soft"] },
  { label: "brand", keys: ["brand", "brand-soft", "brand-blue"] },
  { label: "ai", keys: ["ai", "ai-strong", "ai-hover", "ai-foreground", "ai-soft"] },
  { label: "semantic", keys: ["info", "info-soft", "success", "success-strong", "success-soft", "success-foreground", "warning", "warning-strong", "warning-soft", "warning-foreground", "danger", "danger-strong", "danger-soft", "danger-foreground"] },
  { label: "utility", keys: ["overlay", "focus", "selection"] },
];

export function ThemePicker() {
  const t = useT();
  const { mode, effective, updateCustomColor } = useTheme();
  const [editMode, setEditMode] = useState<ThemeMode>(mode);
  const handleChange = useCallback((key: ColorTokenKey, value: string) => {
    if (isValidColorValue(value)) updateCustomColor(editMode, key, value);
  }, [editMode, updateCustomColor]);

  return (
    <div className="owb-theme-picker">
      <div className="owb-theme-picker__mode-switch">
        <button type="button" className={editMode === "light" ? "active" : ""} onClick={() => setEditMode("light")}>{t("theme.picker.lightMode")}</button>
        <button type="button" className={editMode === "dark" ? "active" : ""} onClick={() => setEditMode("dark")}>{t("theme.picker.darkMode")}</button>
      </div>
      {COLOR_GROUPS.map((group) => (
        <div key={group.label} className="owb-theme-picker__group">
          <h4 className="owb-theme-picker__group-label">{t(`theme.picker.group.${group.label}`)}</h4>
          <div className="owb-theme-picker__items">
            {group.keys.map((key) => <ColorItem key={`${editMode}-${key}`} tokenKey={key} value={effective[key]} onChange={(value) => handleChange(key, value)} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ColorItem({ tokenKey, value, onChange }: { tokenKey: ColorTokenKey; value: string; onChange: (value: string) => void; }) {
  const [inputValue, setInputValue] = useState(value);
  const handleBlur = () => {
    if (inputValue !== value && isValidColorValue(inputValue)) onChange(inputValue);
    else setInputValue(value);
  };
  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value; setInputValue(newValue);
    if (isValidColorValue(newValue)) onChange(newValue);
  };
  return (
    <div className="owb-theme-picker__item">
      <label className="owb-theme-picker__item-label" title={`--ui-${tokenKey}`}>{tokenKey}</label>
      <div className="owb-theme-picker__item-controls">
        <input type="color" value={value.startsWith("#") ? value.slice(0, 7) : "#000000"} onChange={handleColorChange} className="owb-theme-picker__color-input" />
        <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onBlur={handleBlur} onKeyDown={(e) => { if (e.key === "Enter") handleBlur(); }} className="owb-theme-picker__text-input" />
      </div>
    </div>
  );
}
