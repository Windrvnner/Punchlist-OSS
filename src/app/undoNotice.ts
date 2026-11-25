/**
 * A notice's Undo, and what becomes of the notice when the Undo cannot run (#957). The notice goes when Undo is
 * pressed. Signed out, it comes back to stay until it is used after sign-in or dismissed. A refusal that can clear
 * (storage full, the folder out of reach) puts it back with its Undo for the usual time, to be tried again once there
 * is room. A refusal for good leaves it gone. The UI shows the notice and its button; this file decides. The
 * signed-out rule, `keepUntilSignedIn`, is shared with a failed save's Retry in the store.
 */
import type { Store } from './store';
import type { State } from './state';

type Notice = State['ui']['toasts'][number];
type NoticeAction = Notice['action'];
type UndoNotice = Pick<Notice, 'id' | 'text' | 'action'>;

/** Undo refusals that can clear, so the notice comes back with its Undo to try again. */
const CAN_CLEAR: ReadonlySet<string> = new Set(['storageFull', 'unreachable']);

/**
 * Signed out, nothing can run: says so, and shows the notice again with its action, to stay until it is used after
 * sign-in or dismissed (it would otherwise go after `Store.TOAST_MS`). Returns whether it was signed out.
 */
export function keepUntilSignedIn(store: Store, text: string, action: NoticeAction): boolean {
  const signedOut = store.readOnly();
  if (!signedOut) return false;
  store.toast(signedOut);
  store.toast(text, action, true);
  return true;
}

/** A notice's Undo, pressed or reached with Ctrl Z. */
export async function undoFromNotice(store: Store, notice: UndoNotice): Promise<void> {
  store.dismissToast(notice.id);   // at once: the panel the undo changes takes back the focus the button had
  const opId = notice.action?.opId;
  if (!opId) return;   // only a notice with an Undo comes here; its callers check
  if (keepUntilSignedIn(store, notice.text, notice.action)) return;
  const result = await store.undo(opId);
  if (!result.ok && CAN_CLEAR.has(result.error.kind)) store.toast(notice.text, notice.action);
}
