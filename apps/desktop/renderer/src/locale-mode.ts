/** #146 locale 持久化：与 theme-mode 同款套路——渲染前 seed，切换即落盘。
 * 默认 zh-CN；只接受两个合法值，其余一律回退（不信任存储内容）。 */
import { isOwbLocale, type OwbLocale } from "@roleweave/ui";

const STORAGE_KEY = "owb-locale";

export function seedLocale(): OwbLocale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isOwbLocale(stored) ? stored : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export function persistLocale(locale: OwbLocale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 存储不可用时本次会话内切换仍然生效，只是不跨重启。
  }
}
