import type { ComponentChildren } from 'preact';

// #492: keep the distinguishing words visible between two independently shortened sides.
export function TwinLabel({ text, focus, children }: {
  text: string;
  focus?: string;
  children?: ComponentChildren;
}) {
  const start = focus ? text.indexOf(focus) : -1;
  if (start < 1 || !focus) return <>{children ?? text}</>;
  const end = start + focus.length;
  return <span class="twin-label">
    <span>{text.slice(0, start)}</span>
    <span class="twin-focus">{focus}</span>
    <span>{text.slice(end)}</span>
  </span>;
}
