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
