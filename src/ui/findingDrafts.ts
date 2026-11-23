// What is typed into a finding's edit and its New Finding form, kept until it is saved (#32, #115).
import type { Finding } from '../domain/model';
import { hasTexts, keptDrafts } from './keptDrafts';

/** An open edit of a finding: what is typed, and the finding as the edit began (`base`). */
export type EditDraft = {
  title: string; ws: string; body: string;
  base: { title: string; workstream: string; body: string[] };
};
const isEditDraft = (v: unknown): v is EditDraft => hasTexts('title', 'ws', 'body')(v)
  && hasTexts('title', 'workstream')((v as EditDraft).base)
  && Array.isArray((v as EditDraft).base.body)
  && (v as EditDraft).base.body.every((x) => typeof x === 'string');
/** open edits by finding id, kept across a restart too */
export const editDrafts = keptDrafts('finding-edit', isEditDraft);

/** a form's three fields, as typed */
export type Typed = { title: string; ws: string; body: string };
/** Whether a form still holds exactly what a save sent: then the save lands it and the form closes (#32, #115). */
export const sameAsSent = (d: Typed, sent: Typed) =>
  d.title === sent.title && d.ws === sent.ws && d.body === sent.body;

/**
 * A new finding half written, by deal: leaving the page (another tab, another deal) or pressing Escape keeps it, and
 * the form comes back with it when the Findings page is opened again. Cancel or creating the finding clears it.
 */
export const newFindingDrafts = keptDrafts('new-finding', hasTexts('title', 'ws', 'body'));   // kept across a restart

/** Text typed into a new finding since its Create was sent: an open edit of the finding made, from what was sent
 *  (#115). */
export function keepAsEdit(made: Finding, typed: Typed, sent: EditDraft['base']) {
  editDrafts.set(made.id, { ...typed, base: asStored(sent) });
}

/** What a save sent, as the finding stores it: its title trimmed, as the commands trim it, so the next Save's
 *  comparison with the finding is not thrown by a space typed at the end */
export const asStored = (sent: EditDraft['base']): EditDraft['base'] =>
  ({ title: sent.title.trim(), workstream: sent.workstream, body: sent.body });
