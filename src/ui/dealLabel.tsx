import type { ComponentChildren } from 'preact';
import type { TwinFocus } from '../app/dealLabel';

// #492: keep the distinguishing words visible between two independently shortened sides.
export function TwinLabel({ text, focus, children }: {
  text: string;
  focus?: TwinFocus;
  children?: ComponentChildren;
}) {
  if (!focus) return <>{children ?? text}</>;
  const label = text.replace(/\s+/g, ' ');
  return <span class="twin-label">
    <span>{label.slice(0, focus.start)}</span>
    <span class="twin-focus">{label.slice(focus.start, focus.end)}</span>
    <span>{label.slice(focus.end)}</span>
  </span>;
}
