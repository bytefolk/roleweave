/**
 * RoleWeave app mark, drawn as JSX so the splash and the login card can render
 * it without a network/asset request and without a new build loader.
 *
 * Source of truth is `branding/roleweave/roleweave-icon.svg` (see that folder's
 * README: the canvas is filled edge-to-edge so no platform adds a white square
 * around it). This file carries **geometry only** — every `id`/`fill` of the
 * asset became a class, and the brand palette lives in `onboarding.css` as
 * custom properties.
 *
 * Both halves of that split are pinned against the asset by
 * `apps/desktop/test/onboarding-brand-mark.test.cjs`: path data, viewBox and
 * transform must match the SVG, and the CSS custom properties must carry the
 * asset's own hex values. A copy that silently drifts from the shipped icon
 * therefore fails the suite instead of shipping.
 */

export interface BrandMarkProps {
  /** Size/shape come from CSS; this only adds the consumer's own hook. */
  className?: string;
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      className={className === undefined ? "owb-brandmark" : `owb-brandmark ${className}`}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <g className="owb-brandmark__artwork" transform="translate(32 32) scale(0.875)">
        <rect className="owb-brandmark__tile" x="0" y="0" width="512" height="512" rx="126" />
        <rect className="owb-brandmark__edge" x="8" y="8" width="496" height="496" rx="118" />
        <path className="owb-brandmark__role" d="M116 406V106h104c78 0 126 38 126 102 0 46-23 78-66 94l79 104h-87l-66-91h-22v91h-68Zm68-236v89h31c40 0 61-15 61-43 0-30-21-46-61-46h-31Z" />
        <path className="owb-brandmark__weave" d="M150 244h43l33 79 33-53 33 53 33-79h43l-53 145h-43l-30-54-30 54h-43Z" />
        <path className="owb-brandmark__cut" d="m213 362 22-34 10 10-22 34Z" />
        <path className="owb-brandmark__cut" d="m337 338 10-10 22 34-10 10Z" />
        <circle className="owb-brandmark__node" cx="116" cy="106" r="9" />
        <circle className="owb-brandmark__node" cx="412" cy="264" r="9" />
      </g>
    </svg>
  );
}
