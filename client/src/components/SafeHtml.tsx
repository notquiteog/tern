import { useMemo } from 'react';
import { sanitizeForView } from '../lib/sanitize';

// The one way HTML strings become DOM in the app page: sanitised first.
// Used for previews (templates, sequence steps, review items, suggested
// replies). Received mail proper goes through MessageBody's sandboxed frame.
export function SafeHtml({ html, className, style }: { html: string | null | undefined; className?: string; style?: React.CSSProperties }) {
  const clean = useMemo(() => sanitizeForView(String(html ?? '')), [html]);
  return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: clean }} />;
}
