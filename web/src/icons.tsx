/** The Scrying Eye mark and the nav icons: inline stroke SVGs that take the text colour. */

export function EyeMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M2 16C6.5 8.5 11 5.5 16 5.5S25.5 8.5 30 16C25.5 23.5 21 26.5 16 26.5S6.5 23.5 2 16Z" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="16" cy="16" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="16" cy="16" r="2.6" fill="currentColor" />
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
export const CampaignsIcon = icon(<path d="M4 6l8-3 8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9z" />);
export const SettingsIcon = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </>,
);
