/**
 * The lines where a file loads a module `forbidden` refuses, by the UI's own scan, for another layer's rule (#648).
 * As for the UI, a load whose path is not a plain string, and import.meta other than .env, count too.
 */
export function importsIn(file: string, source: string, forbidden: (name: string) => boolean): number[];
/** The lines of each kind of UI dependency the pane-of-glass check finds in a file. */
export function matchesIn(file: string, source: string): Record<string, number[]>;
