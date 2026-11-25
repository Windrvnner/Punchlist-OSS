import { TEXT_MAX, TOO_LONG } from '../domain/importExport';

/**
 * A text box whose text has reached the most one Excel cell holds shows a red outline, and the tooltip says why typing
 * has stopped there. The box itself stops further typing (`maxLength`, or the cited editor's own guard).
 */
export const atLimit = (text: string) => text.length >= TEXT_MAX;
/** the extra class a box takes at the limit */
export const limitClass = (text: string) => (atLimit(text) ? ' atlimit' : '');
/** the tooltip of a box at the limit */
export const limitTitle = (text: string) => (atLimit(text) ? TOO_LONG : undefined);
