/**
 * Who is using the app and which models are on offer.
 *
 * The name comes from the model service, or from the PC's signed-in user when the service cannot say. The models on
 * offer are the three tiers, by their generic names only (Fast, Standard, Thorough; never a vendor's or a model's own
 * name): which model each tier is comes from the service (control: models), and which tiers are offered from
 * control.picker.
 * The time the app was last opened, and the name shown while nobody is signed in, are kept in a small local file.
 */
import os from 'node:os';
import { ok, fail } from '../domain/result';
import type { Session } from '../ports';
import type { ModelService } from './service';
import type { Folder } from './logRepository';
import { SERVICE, control } from '../control';

const TIERS = [['fast', 'Fast'], ['standard', 'Standard'], ['thorough', 'Thorough']] as const;

export const initialsOf = (name: string) => { const parts = name.trim().split(/[\s._-]+/).filter(Boolean); return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase(); };

export function nodeSession(o: {
  service: Pick<ModelService, 'whoami' | 'models'>;
  local: Folder;
  signedIn?: () => string;
  clock?: () => string;
  picker?: { fast: boolean; standard: boolean; thorough: boolean };
  waitMs?: number;
  /** whether a call is waiting for someone to sign in: start-up waits for that, however long */
  signingIn?: () => boolean;
  /** a call waits for a sign-in that has no window to happen in */
  signedOut?: () => boolean;
  /** opens the single sign-on window again, where there is one: start-up's Retry does, after it was closed */
  signInAgain?: () => void;
  /** whether someone is signed in right now: when nobody is, start-up does not wait (the app opens read-only) */
  signedInNow?: () => boolean;
}): Session {
  const clock = o.clock ?? (() => new Date().toISOString());
  // a call to the service waits for a sign-in however long it takes (src/backend/signInToken.ts), and so does start-up.
  // Start-up gives up only on a service that does not answer: after
  // control.timings.modelWait with nobody being waited on to sign in, it says the service could not be reached and the start
  // screen offers Retry. A service that cannot be reached at all fails at once. Only a sign-in window in front of the person
  // is waited on: without one (single sign-on off, no API key entered yet) start-up stops after the same wait and says so.
  const capped = <T,>(p: Promise<T>): Promise<T> => {
    const limit = o.waitMs ?? control.timings.modelWait; let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => { const arm = () => { t = setTimeout(() => (o.signingIn?.() ? arm() : no(new Error('no answer yet'))), limit); }; arm(); });
    return Promise.race([p, late]).finally(() => clearTimeout(t));
  };
  const signedIn = o.signedIn ?? (() => os.userInfo().username);
  const read = (): { lastSeen?: string; name?: string } => {
    try {
      return JSON.parse(o.local.read('profile.json') ?? '{}');
    } catch {
      return {};
    }
  };
  let before: string | null = null;                              // when the app was last opened before this run
  return {
    async load(opts) {
      // nobody signed in: the app opens read-only (decisions: "Intelligence sign-in") as the person last seen here, with no
      // models until someone signs in, when the window loads this again
      if (o.signedInNow && !o.signedInNow()) {
        const p = read(); let name = p.name ?? ''; if (!name) { try { name = signedIn(); } catch { name = ''; } }
        if (before === null) { const now = clock(); before = p.lastSeen ?? now; try { o.local.write('profile.json', JSON.stringify({ ...p, lastSeen: now })); } catch { /* only the "since you were last here" date is lost */ } }
        return ok({ user: { name, initials: initialsOf(name) }, lastSeen: before, models: [], defaultModel: '' });
      }
      let offered: Awaited<ReturnType<ModelService['models']>>;
      // Retry after the sign-on window was closed opens it again, so start-up waits on it once more; nothing else reopens it
      if (opts?.retry && o.signedOut?.()) o.signInAgain?.();
      try { offered = await capped(o.service.models()); } catch {
        // with no sign-in window (closed, or an API key not entered yet), waiting would wait for good: say what is missing instead.
        // That is not a lost connection, so it is not 'unreachable': the start screen shows it with Retry
        if (!o.signedOut?.()) return fail({ kind: 'unreachable', message: `${SERVICE} could not be reached.` });
        return fail({ kind: 'rejected', message: o.signInAgain ? 'Nobody is signed in.' : 'Nobody is signed in. Enter an API key in Settings, then Retry.' });
      }
      if (!offered.models.length) return fail({ kind: 'failed', message: `${SERVICE} offers no models.` });
      let name = ''; try { name = (await capped(o.service.whoami())).name.trim(); } catch { /* the PC's own user, below */ }
      if (!name) { try { name = signedIn(); } catch { name = ''; } }
      const p = read(); const now = clock();
      if (before === null) { before = p.lastSeen ?? now; try { o.local.write('profile.json', JSON.stringify({ ...p, lastSeen: now, name })); } catch { /* only the "since you were last here" date is lost */ } }
      else if (name && p.name !== name) { try { o.local.write('profile.json', JSON.stringify({ ...p, name })); } catch { /* only the name shown while signed out is lost */ } }
      // one entry per tier turned on, by the tier's name; two tiers on the same model are one entry, under the first
      const models: { id: string; name: string }[] = [];
      for (const [tier, label] of TIERS) if ((o.picker ?? control.picker)[tier] && !models.some((m) => m.id === offered[tier])) models.push({ id: offered[tier], name: label });
      if (!models.length) models.push({ id: offered.standard, name: 'Standard' });   // the control file's check keeps one on
      const defaultModel = models.some((m) => m.id === offered.default) ? offered.default : models[0].id;
      return ok({ user: { name, initials: initialsOf(name) }, lastSeen: before, models, defaultModel });
    },
  };
}
