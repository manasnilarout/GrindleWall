import type { ReactNode, SVGProps } from 'react';

/**
 * Small stroke icons for the Grindelwald chrome. They are decorative, not a
 * second source of meaning: every control still has its label.
 */
export type IconName =
  | 'wand'
  | 'lightning'
  | 'owl'
  | 'scroll'
  | 'hourglass'
  | 'snitch'
  | 'castle'
  | 'potion'
  | 'crystal'
  | 'book'
  | 'hat'
  | 'mic'
  | 'micOff'
  | 'sparkle'
  | 'quill'
  | 'key'
  | 'plus'
  | 'download'
  | 'copy'
  | 'compare'
  | 'close'
  | 'expand'
  | 'collapse'
  | 'refresh'
  | 'send'
  | 'shield'
  | 'cauldron'
  | 'glasses'
  | 'broom'
  | 'moon'
  | 'stars'
  | 'linkOff';

const svgProps = (size: number, className?: string): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: className ? `icon ${className}` : 'icon',
  'aria-hidden': true,
  focusable: false,
});

const PATHS: Record<IconName, ReactNode> = {
  wand: (
    <>
      <path d="M4 20 L15.2 8.8" />
      <path d="M16.4 4.4 L16.8 6.8 L19 7.4 L16.8 8 L16.4 10.4 L16 8 L13.8 7.4 L16 6.8 Z" fill="currentColor" stroke="none" />
      <path d="M18.6 3.2 L18.9 4.4" />
      <path d="M20.6 5.2 L21.6 5.6" />
    </>
  ),
  lightning: <path d="M13 2 L5 14 H12 L11 22 L19 10 H12 Z" fill="currentColor" stroke="none" />,
  owl: (
    <>
      <path d="M5 11 A7 7 0 0 1 19 11 V16 A6 6 0 0 1 5 16 Z" />
      <circle cx="9.2" cy="12.2" r="1.7" />
      <circle cx="14.8" cy="12.2" r="1.7" />
      <path d="M12 13.6 L10.8 15.6 H13.2 Z" fill="currentColor" stroke="none" />
      <path d="M8 7 L6 4.5" />
      <path d="M16 7 L18 4.5" />
    </>
  ),
  scroll: (
    <>
      <path d="M6.5 6.5 H17 A2 2 0 0 1 19 8.5 V18 A1.6 1.6 0 0 1 17.4 19.6 H7.2" />
      <path d="M6.5 6.5 A2 2 0 0 0 4.5 8.5 V18 A1.8 1.8 0 0 0 8 18.2" />
      <path d="M9 10 H15.5" />
      <path d="M9 13 H15.5" />
      <path d="M9 16 H13" />
    </>
  ),
  hourglass: (
    <>
      <path d="M7 4 H17" />
      <path d="M7 20 H17" />
      <path d="M8 4 C8 8 16 8 12 12 C8 16 16 16 16 20" />
      <path d="M16 4 C16 8 8 8 12 12 C16 16 8 16 8 20" />
    </>
  ),
  snitch: (
    <>
      <circle cx="12" cy="13.2" r="3.4" />
      <path d="M12 10.4 V8.8" />
      <path d="M3.5 11 C6 8 8.5 9.5 9 12 C7.2 12.2 5 13 3.5 11 Z" />
      <path d="M20.5 11 C18 8 15.5 9.5 15 12 C16.8 12.2 19 13 20.5 11 Z" />
    </>
  ),
  castle: (
    <>
      <path d="M4 20 V11 L7 8 V11 H9 V6 L12 3.5 L15 6 V11 H17 V8 L20 11 V20 Z" />
      <path d="M10.5 20 V15 H13.5 V20" />
      <path d="M12 8.2 V10" />
    </>
  ),
  potion: (
    <>
      <path d="M9 4 H15" />
      <path d="M10.5 4 V8.2 C7.6 10.4 6.4 13.2 6.8 16.6 C7.2 19.4 9.4 21 12 21 C14.6 21 16.8 19.4 17.2 16.6 C17.6 13.2 16.4 10.4 13.5 8.2 V4" />
      <path d="M8 15.6 H16" />
    </>
  ),
  crystal: (
    <>
      <path d="M12 3 L19 10 L12 21 L5 10 Z" />
      <path d="M5 10 H19" />
      <path d="M12 3 L10 10 L12 21 L14 10 Z" />
    </>
  ),
  book: (
    <>
      <path d="M4.5 6.2 C7.5 4.8 10 5.6 12 7 V19 C10 17.8 7.5 17 4.5 18.2 Z" />
      <path d="M19.5 6.2 C16.5 4.8 14 5.6 12 7 V19 C14 17.8 16.5 17 19.5 18.2 Z" />
    </>
  ),
  hat: (
    <>
      <path d="M5 18 C8 16.4 16 16.4 19 18 C16.5 20.4 7.5 20.4 5 18 Z" />
      <path d="M8.4 16.6 C8 12.5 9.2 8.4 12.6 5 C13.8 8.2 16.4 10.4 16.2 14.6" />
      <path d="M10.2 11.2 H13" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M7 11.2 A5 5 0 0 0 17 11.2" />
      <path d="M12 16.2 V19.5" />
      <path d="M9 19.5 H15" />
    </>
  ),
  micOff: (
    <>
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M7 11.2 A5 5 0 0 0 17 11.2" />
      <path d="M12 16.2 V19.5" />
      <path d="M9 19.5 H15" />
      <path d="M5 5 L19 19" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3 L13.4 9.2 L19.5 10.5 L13.4 11.8 L12 18 L10.6 11.8 L4.5 10.5 L10.6 9.2 Z" fill="currentColor" stroke="none" />
    </>
  ),
  quill: (
    <>
      <path d="M19.5 4.5 C14 5.5 9 10 6.5 16.5 L5 20 L8.4 18.6 C14.8 16.2 18.4 10.4 19.5 4.5 Z" />
      <path d="M8.2 15.8 L12.4 11.6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="10" r="3.2" />
      <path d="M11 10 H20 V12.4 H17.6 V15 H15.4 V12.4 H13.8" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5 V19" />
      <path d="M5 12 H19" />
    </>
  ),
  download: (
    <>
      <path d="M12 4 V15" />
      <path d="M8 11.5 L12 16 L16 11.5" />
      <path d="M5 19 H19" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="7" width="10" height="13" rx="1.6" />
      <path d="M6.2 16.5 V5.6 A1.6 1.6 0 0 1 7.8 4 H15" />
    </>
  ),
  compare: (
    <>
      <path d="M6 18 V9" />
      <path d="M12 18 V6" />
      <path d="M18 18 V12" />
    </>
  ),
  close: (
    <>
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </>
  ),
  expand: (
    <>
      <path d="M7 14 L12 9 L17 14" />
    </>
  ),
  collapse: (
    <>
      <path d="M7 10 L12 15 L17 10" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.2 12 A7.2 7.2 0 1 1 17.4 6.4" />
      <path d="M17.4 3.6 V6.6 H14.4" />
    </>
  ),
  send: (
    <>
      <path d="M4 12 L20 5 L14 19 L12.2 13.2 Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.4 L19 6.2 V12.2 C19 16.6 15.8 19.8 12 21 C8.2 19.8 5 16.6 5 12.2 V6.2 Z" />
      <path d="M9.2 12.2 L11.1 14.1 L15.2 9.8" />
    </>
  ),
  cauldron: (
    <>
      <path d="M5.2 11 H18.8 C18.8 17.4 16.2 21 12 21 C7.8 21 5.2 17.4 5.2 11 Z" />
      <path d="M4 10.4 H20" />
      <path d="M8.5 6.5 C9.2 5.2 10.6 5.6 11 6.8" />
      <path d="M13 5.4 C13.8 4.2 15.4 4.8 15.2 6.4" />
    </>
  ),
  glasses: (
    <>
      <circle cx="8" cy="13" r="3.2" />
      <circle cx="16" cy="13" r="3.2" />
      <path d="M11.2 13 H12.8" />
      <path d="M4.8 13 H3.6" />
      <path d="M19.2 13 H20.4" />
    </>
  ),
  broom: (
    <>
      <path d="M4 20 L15.5 8.5" />
      <path d="M14.4 6.2 L18.6 10.4" />
      <path d="M15 6.8 L20 4.6" />
      <path d="M16.2 8 L21 6.4" />
      <path d="M16.8 9.4 L21.2 8.4" />
    </>
  ),
  moon: (
    <>
      <path d="M15.4 4.6 A8 8 0 1 0 19.2 15.6 A6.2 6.2 0 1 1 15.4 4.6 Z" />
    </>
  ),
  stars: (
    <>
      <path d="M8 5 L8.7 7.2 L11 8 L8.7 8.8 L8 11 L7.3 8.8 L5 8 L7.3 7.2 Z" fill="currentColor" stroke="none" />
      <path d="M16.5 10 L17.1 12 L19.2 12.6 L17.1 13.2 L16.5 15.2 L15.9 13.2 L13.8 12.6 L15.9 12 Z" fill="currentColor" stroke="none" />
      <path d="M12.2 15.6 L12.6 17 L14 17.4 L12.6 17.8 L12.2 19.2 L11.8 17.8 L10.4 17.4 L11.8 17 Z" fill="currentColor" stroke="none" />
    </>
  ),
  linkOff: (
    <>
      <path d="M8.4 15.6 L6.8 17.2 A3.2 3.2 0 0 1 2.2 12.6 L5 9.8" />
      <path d="M15.6 8.4 L17.2 6.8 A3.2 3.2 0 0 1 21.8 11.4 L19 14.2" />
      <path d="M5 5 L19 19" />
    </>
  ),
};

export function Icon({
  name,
  size = 14,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return <svg {...svgProps(size, className)}>{PATHS[name]}</svg>;
}

/** Heading prefix used by every panel so the icons share one size and gap. */
export function PanelIcon({ name }: { name: IconName }) {
  return <Icon name={name} size={13} className="panel-icon" />;
}
