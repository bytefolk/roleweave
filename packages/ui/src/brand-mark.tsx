/**
 * ByteFolk “Open Herd” mark, cropped from the supplied organization logo
 * concept at organization-profile/brand/logo-concepts/bytefolk-concept-c-open-herd-mark.svg.
 * The wordmark is intentionally omitted because this is the compact
 * organization identity slot; the full logo remains the source of truth.
 *
 * The identity slot lives in the sidebar's project switcher: the directory
 * tree leads with people (the owner position at the top level), so the
 * project's own face belongs to the project row above the tree.
 */
export function BytefolkOpenHerdMark() {
  return (
    <svg
      className="owb-brand-mark"
      data-brand="bytefolk-open-herd"
      viewBox="0 0 142 116"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="#1677ff" d="M12 28a8 8 0 0 1 8-8h28v36H12V28Zm8-20h12v14H20Z" />
      <path fill="#722ed1" d="M56 20h31a9 9 0 0 1 9 9v27H56V20Zm28-12h12v18H84Z" />
      <path fill="#141414" d="M12 64h36v44H28a16 16 0 0 1-16-16V64Z" />
      <path fill="#1677ff" d="M56 64h40v10h18a14 14 0 0 1 14 14v6a14 14 0 0 1-14 14H56V64Z" />
      <rect x="70" y="75" width="10" height="10" rx="3" fill="#fff" />
      <rect x="99" y="84" width="7" height="10" rx="3" fill="#fff" />
      <rect x="114" y="84" width="7" height="10" rx="3" fill="#fff" />
      <rect x="48" y="20" width="8" height="88" fill="#fff" />
      <rect x="12" y="56" width="84" height="8" fill="#fff" />
    </svg>
  );
}
