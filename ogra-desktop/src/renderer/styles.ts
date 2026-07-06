import type { CSSProperties } from 'react';

/** Primary action button (green). */
export const buttonStyle: CSSProperties = {
  padding: '8px 16px',
  border: '1px solid #30363d',
  borderRadius: '6px',
  backgroundColor: '#238636',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 500,
};

/** Secondary / neutral button (dark background). */
export const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: '#21262d',
};

/** Destructive button (red). */
export const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: '#21262d',
  color: '#f85149',
  borderColor: '#da3633',
};

/** Inline spinner keyframes; inserted once near the spinner element via
 *  a <style> tag. Caller MUST mount it once per app shell. */
export const spinnerKeyframes = `@keyframes ogra-spin { to { transform: rotate(360deg); } }`;

/** Reusable spinner. Caller adds `animation: 'ogra-spin 0.8s linear infinite'`. */
export const spinnerStyle: CSSProperties = {
  display: 'inline-block',
  width: '12px',
  height: '12px',
  border: '2px solid currentColor',
  borderTopColor: 'transparent',
  borderRadius: '50%',
  marginRight: '6px',
  verticalAlign: 'middle',
  animation: 'ogra-spin 0.8s linear infinite',
};

/** Tone presets for status / banner surfaces. Single source of truth so
 *  the bottom status bar, in-tab banners, and incident rows all agree. */
export type StatusTone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export interface ToneStyle {
  fg: string;
  bg: string;
  border: string;
  icon: string;
  label: string;
}

export const toneStyles: Record<StatusTone, ToneStyle> = {
  neutral:   { fg: '#8b949e', bg: '#0f1117', border: '#21262d', icon: '·',   label: 'Idle'     },
  info:      { fg: '#58a6ff', bg: '#0d1929', border: '#1f3a5f', icon: 'ⓘ',   label: 'Info'     },
  progress:  { fg: '#d29922', bg: '#2a1d05', border: '#5a3f0a', icon: '◐',   label: 'Working'  },
  success:   { fg: '#3fb950', bg: '#0a2818', border: '#1f5234', icon: '✓',   label: 'Ready'    },
  warning:   { fg: '#d29922', bg: '#2a1d05', border: '#5a3f0a', icon: '!',   label: 'Blocked'  },
  danger:    { fg: '#f85149', bg: '#2a0a0a', border: '#5a1a1a', icon: '✕',   label: 'Error'    },
};

/** Classify a free-form status string into a Tone. The matches are
 *  conservative — anything we don't recognise falls back to neutral. */
export function classifyStatus(message: string): StatusTone {
  const m = message.toLowerCase();
  if (m.startsWith('error') || m.includes('failed') || m.includes('exception')) return 'danger';
  if (m.includes('blocked')) return 'warning';
  if (m.includes('complete') || m === 'ready') return 'success';
  if (
    m.startsWith('loading') ||
    m.startsWith('creating') ||
    m.startsWith('starting') ||
    m.startsWith('importing') ||
    m.startsWith('re-indexing') ||
    m.startsWith('run ') ||
    m.includes('demo')
  ) {
    return 'progress';
  }
  if (m.startsWith('workspace:') || m.includes('classification updated') || m.includes('created')) {
    return 'info';
  }
  return 'neutral';
}
