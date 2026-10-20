/** The Scrying Eye mark and the nav icons: inline stroke SVGs that take the text colour. */

/** The Scrying Eye mark: a crystal orb in a cradle with an eye inside (matches scripts/make-icons.mjs). */
export function OrbMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="16" cy="13.5" r="10.5" />
      <path d="M9.5 21.5 8 27.5h16l-1.5-6" />
      <path d="M10 13.5C12 10.8 14 9.5 16 9.5S20 10.8 22 13.5C20 16.2 18 17.5 16 17.5S12 16.2 10 13.5Z" />
      <circle cx="16" cy="13.5" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

const icon = (paths: React.ReactNode) =>
  function Icon() {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {paths}
      </svg>
    );
  };

export const RecordIcon = icon(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </>,
);
export const SessionsIcon = icon(
  <>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M9.5 11h6M9.5 15h6" />
  </>,
);
export const MusicIcon = icon(
  <>
    <path d="M9 18V5l11-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </>,
);
export const CampaignsIcon = icon(<path d="M4 6l8-3 8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9z" />);
export const SettingsIcon = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </>,
);
