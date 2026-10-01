/**
 * #519 first-run splash: the brand mark enters, holds, and hands off
 * (shared-element transition into the login card).
 *
 * Three phases, expressed by `phase`, interpolated by CSS:
 *   - `"splash"`: the mark goes scale 0.85→1 and opacity 0→1 over ~350ms with
 *     cubic-bezier(0.22, 1, 0.36, 1); the wordmark fades in afterwards and
 *     settles;
 *   - `"docking"`: the mark shrinks and fades while the login card's own header
 *     logo cross-fades in (a path the motion spec explicitly allows), and the
 *     supporting halo disperses;
 *   - nothing else: under `prefers-reduced-motion` only the opacity fades
 *     remain, and OnboardingGate shortens the whole sequence.
 *
 * The progress hint (three pulsing dots) is pure CSS, delayed to ~600ms by
 * `animation-delay`, so the last stretch of waiting gets feedback without the
 * first 600ms implying that something is stuck.
 */
import { BrandMark } from "./BrandMark";

export type SplashPhase = "splash" | "docking";

export interface SplashScreenProps {
  phase: SplashPhase;
  /** Announcement for assistive technology; comes from the i18n catalog. */
  label: string;
  /** Secondary line under the wordmark. */
  hint: string;
  wordmark: string;
}

export function SplashScreen({ phase, label, hint, wordmark }: SplashScreenProps) {
  return (
    <div
      className="owb-splash"
      data-phase={phase}
      role="status"
      aria-label={label}
    >
      <div className="owb-splash__halo" aria-hidden="true" />
      <div className="owb-splash__mark">
        <BrandMark className="owb-brandmark--splash" />
      </div>
      <p className="owb-splash__wordmark">{wordmark}</p>
      <p className="owb-splash__hint">{hint}</p>
      <div className="owb-splash__progress" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
