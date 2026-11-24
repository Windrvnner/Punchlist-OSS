// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { restartKeptText } from './keptTextSession';
import { EditField, ReadOnlyContext } from '../../src/ui/editField';
import { CONNECTED } from '../../src/app/connection';
import { CHANGED_ELSEWHERE } from '../../src/app/changedElsewhere';

/** A tiny host standing in for the store: the field commits, the "record" changes when the host says so. */
function mount(initial: string, multiline = true) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const rec = { value: initial, rev: 1 }; const commits: { v: string; resolve: (ok: boolean) => void }[] = [];
  const commit = (v: string) => new Promise<{ ok: boolean }>((res) => commits.push({ v, resolve: (ok) => { if (ok) { rec.value = v; rec.rev++; } res({ ok }); } }));
  const draw = () => act(() => { render(<EditField label="Question" multiline={multiline} value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, host); });
  draw();
  const el = () => host.querySelector(multiline ? 'textarea' : 'input') as HTMLTextAreaElement;
  const type = (v: string) => act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
  const settle = (ms = 40) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
  return { host, rec, commits, draw, el, type, settle, text: () => host.textContent ?? '' };
}

describe('EditField', () => {
  it('typing straight after the field appears is never overwritten', async () => {
    // rendered without act(): effects have not run yet when the first input arrives, as in a real browser frame
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = [];
    render(<EditField label="Question" multiline value="" rev={1} commit={async (v) => { sent.push(v); return { ok: true }; }} debounceMs={20} />, host);
    const el = host.querySelector('textarea')!; el.dispatchEvent(new FocusEvent('focus')); el.value = 'typed at once'; el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    expect(el.value).toBe('typed at once'); expect(sent).toEqual(['typed at once']);
  });

  it('its own save landing while the person keeps typing is not reported as a change made elsewhere', async () => {
    const f = mount('abc');
    await f.type('abcd'); await f.settle();                       // debounce fires: saving 'abcd'
    await f.type('abcde');                                         // keeps typing while the save is out
    await act(async () => { f.commits[0].resolve(true); }); await f.draw();
    expect(f.el().value).toBe('abcde');
    expect(f.text()).not.toMatch(/Changed elsewhere/);
    await f.settle(); await act(async () => { f.commits[1].resolve(true); }); await f.draw(); await f.settle();
    expect(f.rec.value).toBe('abcde'); expect(f.text()).not.toMatch(/Changed elsewhere|Not saved/);
  });

  it('another field of the same record saving while this one is being typed in is not a change made elsewhere', async () => {
    const f = mount('abc');
    await f.type('abcd');                                          // typing here, nothing sent yet
    f.rec.rev++; await f.draw();                                   // the field next door saved: the record moved on, this value did not
    expect(f.el().value).toBe('abcd'); expect(f.text()).not.toMatch(/Changed elsewhere/);
    await act(() => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle();
    expect(f.commits.map((c) => c.v)).toEqual(['abcd']);           // and leaving the field saves it
    await act(async () => { f.commits[0].resolve(true); }); await f.draw(); await f.settle();
    expect(f.rec.value).toBe('abcd'); expect(f.text()).not.toMatch(/Changed elsewhere|Not saved/);
  });

  it('a change from elsewhere while typing is offered, not applied; untouched fields just follow the record', async () => {
    const f = mount('abc');
    f.rec.value = 'from another tab'; f.rec.rev++; await f.draw();
    expect(f.el().value).toBe('from another tab');               // nothing typed here: follow the record
    await f.type('mine');
    f.rec.value = 'theirs'; f.rec.rev++; await f.draw();
    expect(f.el().value).toBe('mine'); expect(f.text()).toMatch(/Changed elsewhere/);
    await act(async () => { [...f.host.querySelectorAll('button')].find((b) => b.textContent ===
      'Take Theirs')!.click(); });
    expect(f.el().value).toBe('theirs'); expect(f.text()).not.toMatch(/Changed elsewhere/);
    await f.settle(); expect(f.commits.length).toBe(0);           // taking theirs saves nothing
  });

  it('a save the folder was out of reach for says "Retry now", and the field sends its text as it is now once the app is connected', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const rec = { value: 'abc', rev: 1 }; const sent: string[] = []; let reach = false;
    const commit = async (v: string) => { sent.push(v); if (!reach) return { ok: false, error: { kind: 'unreachable', message: 'The Punchlist folder cannot be written to' } }; rec.value = v; rec.rev++; return { ok: true }; };
    const draw = () => act(() => { render(<EditField label="Question" multiline value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, host); });
    await draw(); const el = host.querySelector('textarea')!;
    const type = (v: string) => act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await type('abcd'); await settle();
    expect(host.querySelector('.efstate.fail')!.textContent).toBe('Not saved · Retry now');
    await type('abcd and more'); await settle();                    // typing on while the folder is away
    reach = true; await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await settle(); await draw(); await settle();
    await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await settle();      // connected again later: nothing more to send
    expect(sent).toEqual(['abcd', 'abcd and more', 'abcd and more']); expect(rec.value).toBe('abcd and more');
    expect(el.value).toBe('abcd and more'); expect(host.textContent).not.toMatch(/Not saved|Changed elsewhere/);
  });

  it('text taken back to what was saved after a failed save is sent once, so the waiting save is known to be unwanted, and not again when the app is connected', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = [];
    await act(() => { render(<EditField label="Question" multiline value="abc" rev={1} commit={async (v) => { sent.push(v); return v === 'abc' ? { ok: true } : { ok: false, error: { kind: 'unreachable', message: 'x' } }; }} debounceMs={20} />, host); });   // the record holds "abc": the Store has nothing to write for it
    const el = host.querySelector('textarea')!;
    const type = (v: string) => act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await type('abcd'); await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await type('abc'); await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(sent).toEqual(['abcd', 'abc']); expect(host.textContent).not.toMatch(/Not saved/);
  });

  it('does not resend over a newer edit from another PC that arrived meanwhile: the person chooses (Keep mine / Take theirs)', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const rec = { value: 'abc', rev: 1 }; const sent: string[] = [];
    const draw = () => act(() => { render(<EditField label="Question" multiline value={rec.value} rev={rec.rev} commit={async (v) => { sent.push(v); return { ok: false, error: { kind: 'unreachable', message: 'x' } }; }} debounceMs={20} />, host); });
    await draw(); const el = host.querySelector('textarea')!; const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'mine'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await settle();
    rec.value = 'theirs, from the other PC'; rec.rev++; await draw();
    await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await settle();
    expect(sent).toEqual(['mine']); expect(el.value).toBe('mine'); expect(host.textContent).toMatch(/Changed elsewhere/);
  });

  it('Take theirs after a save that could not be written sends the record’s own value, so the waiting save is known to be unwanted', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const rec = { value: 'abc', rev: 1 }; const sent: string[] = [];
    const draw = () => act(() => { render(<EditField label="Question" multiline value={rec.value} rev={rec.rev} commit={async (v) => { sent.push(v); return v === rec.value ? { ok: true } : { ok: false, error: { kind: 'unreachable', message: 'x' } }; }} debounceMs={20} />, host); });
    await draw(); const el = host.querySelector('textarea')!; const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'mine'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await settle();
    rec.value = 'theirs'; rec.rev++; await draw();
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Take Theirs')!.click();
      }); await settle();
    expect(sent).toEqual(['mine', 'theirs']); expect(el.value).toBe('theirs'); expect(host.textContent).not.toMatch(/Not saved|Changed elsewhere/);
  });

  it('tries once when the app is connected: if the folder is still away, it says "Retry" and leaves it to the person', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = [];
    await act(() => { render(<EditField label="Question" multiline value="abc" rev={1} commit={async (v) => { sent.push(v); return { ok: false, error: { kind: 'unreachable', message: 'x' } }; }} debounceMs={20} />, host); });
    const el = host.querySelector('textarea')!; const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'abcd'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await settle();
    for (let i = 0; i < 3; i++) { await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await settle(); }
    expect(sent).toEqual(['abcd', 'abcd']); expect(host.querySelector('.efstate.fail')!.textContent).toBe('Not saved · Retry');
  });

  it('a save that failed for another reason says "Retry": it waits for the person', async () => {
    const f = mount('abc');
    await f.type('abcd'); await f.settle();
    await act(async () => { f.commits[0].resolve(false); });
    expect(f.host.querySelector('.efstate.fail')!.textContent).toBe('Not saved · Retry');
  });

  it('a failed save keeps the text and offers Retry', async () => {
    const f = mount('abc');
    await f.type('abcd'); await f.settle();
    await act(async () => { f.commits[0].resolve(false); });
    expect(f.el().value).toBe('abcd'); expect(f.text()).toMatch(/Not saved · Retry/);
    await act(async () => { (f.host.querySelector('.efstate.fail') as HTMLButtonElement).click(); });
    await act(async () => { f.commits[1].resolve(true); }); await f.draw(); await f.settle();
    expect(f.rec.value).toBe('abcd'); expect(f.text()).not.toMatch(/Not saved/);
  });

  it('leaving the screen with a save still waiting sends it', async () => {
    const f = mount('abc');
    await f.type('abcd');
    await act(() => { render(null, f.host); });
    expect(f.commits.map((c) => c.v)).toEqual(['abcd']);
  });

  it('once a change from elsewhere is flagged, nothing saves until the person chooses: not autosave, not leaving the field', async () => {
    const f = mount('abc');
    await f.type('mine');                                          // autosave is now waiting on its timer
    f.rec.value = 'theirs'; f.rec.rev++; await f.draw();           // someone else saves first
    expect(f.text()).toMatch(/Changed elsewhere/);
    await f.settle(80);                                            // well past the autosave delay
    expect(f.commits.length).toBe(0); expect(f.rec.value).toBe('theirs'); expect(f.text()).toMatch(/Changed elsewhere/);
    await act(async () => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle(40);
    expect(f.commits.length).toBe(0); expect(f.text()).toMatch(/Changed elsewhere/);
    await f.type('mine, still typing'); await f.settle(80);
    expect(f.commits.length).toBe(0);
    await act(async () => { [...f.host.querySelectorAll('button')].find((b) => b.textContent === 'Keep Mine')!.click();
      });
    expect(f.commits.map((c) => c.v)).toEqual(['mine, still typing']);
  });

  it('under a read-only reason it sends nothing, keeps what was typed before the reason arrived, and sends it when the reason clears', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = []; const rec = { value: 'As saved', rev: 1 };
    const commit = async (v: string) => { sent.push(v); rec.value = v; rec.rev++; return { ok: true }; };
    const draw = (reason: string | null) => act(() => { render(<ReadOnlyContext.Provider value={reason}><EditField label="Question" multiline value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} /></ReadOnlyContext.Provider>, host); });
    const el = () => host.querySelector('textarea') as HTMLTextAreaElement; const wait = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
    await draw(null);
    // typed, and before the save goes out the record becomes read-only (another version of it arrived)
    await act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = 'Typed just before the lock'; el().dispatchEvent(new Event('input', { bubbles: true })); });
    await draw('Project Proseware has two versions. Choose one first');
    await wait(); await act(() => { el().dispatchEvent(new FocusEvent('blur')); }); await wait();
    expect(sent).toEqual([]);                                             // nothing was sent while read-only
    expect(el().readOnly).toBe(true); expect(el().title).toMatch(/^Project Proseware has two versions/);
    expect(el().value).toBe('Typed just before the lock'); expect(host.textContent).toContain('Not saved');
    await draw(null); await wait();
    expect(sent).toEqual(['Typed just before the lock']);               // the reason cleared: it is sent
    expect(el().readOnly).toBe(false); expect(host.textContent).not.toContain('Not saved');
  });

  it('in a one-line field Escape undoes the edit: back to the value on entry, saving it back if part had already been saved', async () => {
    const f = mount('Proseware Offshore', false);
    await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); });
    const key = (k: string) => act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
    const input = (v: string) => act(() => { f.el().value = v; f.el().dispatchEvent(new Event('input', { bubbles: true })); });
    await input('Proseware Off'); await f.settle(); await act(async () => { f.commits[0].resolve(true); }); await f.draw();   // the debounce already saved part of it
    await input('Proseware Offxx'); await key('Escape'); await f.draw(); await f.settle();
    expect(f.el().value).toBe('Proseware Offshore');
    expect(f.commits.map((c) => c.v)).toEqual(['Proseware Off', 'Proseware Offshore']);                                       // and the partial save is put back
  });

  it('a value the record refuses says why, offers no pointless Retry, and typing stops at the limit', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    await act(() => { render(<EditField label="Counterparty" value="" rev={1} maxLength={80} debounceMs={10} commit={async () => ({ ok: false, error: { kind: 'invalid', message: 'Keep it under 80 characters' } })} />, host); });
    const el = host.querySelector('input')!; expect(el.maxLength).toBe(80);
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'x'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(host.textContent).toContain('Not saved: Keep it under 80 characters'); expect(host.textContent).not.toContain('Retry');
  });

  it('a save a rule of the record refuses says why, with no Retry (clearing an Answered response, a date past 9999)', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    await act(() => { render(<EditField label="Response" multiline value="Lock-up at 1.25x" rev={1} debounceMs={10} commit={async () => ({ ok: false, error: { kind: 'rejected', message: 'This question is marked Answered. Change its status before clearing the response' } })} />, host); });
    const el = host.querySelector('textarea')!;
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(host.textContent).toContain('Not saved: This question is marked Answered. Change its status before clearing the response'); expect(host.textContent).not.toContain('Retry');
    expect(el.value).toBe('');                                                                                              // what was typed stays for the person to change
  });

  it('in a text box Escape keeps what was typed, so closing a panel never throws a passage away', async () => {
    const f = mount('Provide the contract');
    await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); f.el().value = 'Provide the executed contract'; f.el().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await f.draw();
    expect(f.el().value).toBe('Provide the executed contract');
  });

  it('text that could not be saved is not replaced when another PC changes the field: the person chooses', async () => {
    const f = mount('Original');
    await f.type('Mine, not saved'); await f.settle(); await act(async () => { f.commits[0].resolve(false); }); await f.draw();   // the save fails
    await act(() => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle();                                   // leaving the field tries once more, and fails too
    for (const c of f.commits.slice(1)) await act(async () => { c.resolve(false); }); await f.draw();
    f.rec.value = 'Theirs, from the other PC'; f.rec.rev++; await f.draw();
    expect(f.el().value).toBe('Mine, not saved'); expect(f.text()).toMatch(/Changed elsewhere/);
  });

  it('words typed just before a reload or close are sent at once and kept for the next start, shown as Not saved', async () => {
    localStorage.clear();
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = [];
    const commit = (v: string) => { sent.push(v); return new Promise<{ ok: boolean }>(() => {}); };   // the page goes away before the save can land
    await act(() => { render(<EditField keep="q1:text" label="Question" multiline value="Provide the" rev={1} commit={commit} debounceMs={500} />, host); });
    const el = host.querySelector('textarea')!;
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'Provide the executed EPC contract'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    window.dispatchEvent(new Event('pagehide'));                         // reload, well inside the debounce
    expect(sent).toEqual(['Provide the executed EPC contract']);        // sent at once rather than waiting out the debounce
    // the next start: a fresh copy of the module, the record still holding what it had
    render(null, host);
    await restartKeptText();
    const { EditField: Fresh } = await import('../../src/ui/editField');
    await act(() => { render(<Fresh keep="q1:text" label="Question" multiline value="Provide the" rev={1} commit={commit} />, host); });
    expect(host.querySelector('textarea')!.value).toBe('Provide the executed EPC contract');
    expect(host.textContent).toMatch(/Not saved · Retry/);                // the person decides; nothing is sent by itself
    expect(sent).toEqual(['Provide the executed EPC contract']);
    localStorage.clear();
  });

  it('text that could not be saved is back after a crash, with no page-hide, and after the start that follows too', async () => {
    localStorage.clear();
    await restartKeptText();
    const { EditField: First } = await import('../../src/ui/editField');
    const host = document.createElement('div'); document.body.appendChild(host);
    const refused = () => Promise.resolve({ ok: false, error: { kind: 'rejected', message: 'The folder could not be written to' } });
    await act(() => { render(<First keep="q2:text" label="Question" multiline value="" rev={1} commit={refused} debounceMs={50} />, host); });
    const el = host.querySelector('textarea')!;
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'Confirm the step-in period'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => new Promise((r) => setTimeout(r, 120)));                  // the save is refused
    await act(() => { render(null, host); });                               // the person moves on: the text is kept as not saved
    await new Promise((r) => setTimeout(r, 700));                           // then the app dies: no page-hide
    for (let start = 0; start < 2; start++) {
      await restartKeptText();
      const { EditField: Fresh } = await import('../../src/ui/editField');
      await act(() => { render(<Fresh keep="q2:text" label="Question" multiline value="" rev={1} commit={refused} />, host); });
      expect(host.querySelector('textarea')!.value).toBe('Confirm the step-in period');
      expect(host.textContent).toMatch(/Not saved/);
      await act(() => { render(null, host); });
    }
    localStorage.clear();
  });

  it('text whose save was refused is kept at once, while the field still shows Not saved, and follows further typing', async () => {
    localStorage.clear();
    await restartKeptText();
    const { EditField: First } = await import('../../src/ui/editField');
    const host = document.createElement('div'); document.body.appendChild(host);
    const refused = () => Promise.resolve({ ok: false, error: { kind: 'rejected', message: 'The folder could not be written to' } });
    await act(() => { render(<First keep="q3:text" label="Question" multiline value="" rev={1} commit={refused} debounceMs={50} />, host); });
    const el = host.querySelector('textarea')!;
    const type = (v: string) => act(() => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); }); await type('Confirm the step-in');
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(host.textContent).toMatch(/Not saved/);
    await type('Confirm the step-in period');                               // typed on while the save is refused
    await new Promise((r) => setTimeout(r, 700));                           // then the app dies with the field on screen: no unmount, no page-hide
    const crashedHost = document.createElement('div'); document.body.appendChild(crashedHost);
    await restartKeptText();
    const { EditField: Fresh } = await import('../../src/ui/editField');
    await act(() => { render(<Fresh keep="q3:text" label="Question" multiline value="" rev={1} commit={refused} />, crashedHost); });
    expect(crashedHost.querySelector('textarea')!.value).toBe('Confirm the step-in period');
    expect(crashedHost.textContent).toMatch(/Not saved/);
    await act(() => { render(null, crashedHost); render(null, host); });
    localStorage.clear();
  });

  it('signed out while typing: the field stays open until it is left, what is typed is kept at once (a crash keeps it), and it is sent after sign-in; a field not in use stays shut', async () => {
    localStorage.clear();
    await restartKeptText();
    const { EditField: First, ReadOnlyContext: RO, SignedOutContext: Out } = await import('../../src/ui/editField');
    const OUT = 'Sign in to Intelligence to make changes';
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = []; const rec = { value: 'As saved', rev: 1 };
    const commit = async (v: string) => { sent.push(v); rec.value = v; rec.rev++; return { ok: true }; };
    const draw = (reason: string | null) => act(() => { render(<Out.Provider value={reason}><RO.Provider value={reason}>
      <First keep="q4:text" label="Response" multiline value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />
      <First keep="q5:text" label="Question" multiline value="Other field" rev={1} commit={commit} debounceMs={20} />
    </RO.Provider></Out.Provider>, host); });
    const [a, b] = [0, 1].map((i) => () => host.querySelectorAll('textarea')[i] as HTMLTextAreaElement);
    const wait = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
    await draw(null);
    await act(() => { a().dispatchEvent(new FocusEvent('focus')); });
    await draw(OUT);                                                        // the sign-in lapses while the person is in the field
    expect(a().readOnly).toBe(false);
    await act(() => { a().value = 'Typed after the lapse'; a().dispatchEvent(new Event('input', { bubbles: true })); }); await wait();
    expect(sent).toEqual([]);
    // the app dies with the field on screen: what was typed comes back on the next start
    await new Promise((r) => setTimeout(r, 700));
    await restartKeptText();
    const { EditField: Fresh } = await import('../../src/ui/editField');
    const crashed = document.createElement('div'); document.body.appendChild(crashed);
    await act(() => { render(<Fresh keep="q4:text" label="Response" multiline value="As saved" rev={1} commit={commit} />, crashed); });
    expect(crashed.querySelector('textarea')!.value).toBe('Typed after the lapse');
    await act(() => { render(null, crashed); });
    // a field that was not in use stays shut when clicked; the one in use shuts once it is left
    await act(() => { b().dispatchEvent(new FocusEvent('focus')); }); expect(b().readOnly).toBe(true);
    await act(() => { a().dispatchEvent(new FocusEvent('blur')); }); expect(a().readOnly).toBe(true);
    await draw(null); await wait();                                         // signed in again: it is sent
    expect(sent).toEqual(['Typed after the lapse']);
    await act(() => { render(null, host); }); localStorage.clear();
  });

  it('text typed just before the sign-in lapses, not yet sent, is kept on this PC at once: a crash keeps it', async () => {
    localStorage.clear();
    await restartKeptText();
    const { EditField: First, ReadOnlyContext: RO, SignedOutContext: Out } = await import('../../src/ui/editField');
    const host = document.createElement('div'); document.body.appendChild(host); const sent: string[] = [];
    const commit = async (v: string) => { sent.push(v); return { ok: true }; };
    const draw = (reason: string | null) => act(() => { render(<Out.Provider value={reason}><RO.Provider value={reason}><First keep="q6:text" label="Response" multiline value="As saved" rev={1} commit={commit} debounceMs={500} /></RO.Provider></Out.Provider>, host); });
    await draw(null);
    const el = host.querySelector('textarea')!;
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'Typed just before'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 100)); await draw('Sign in to Intelligence to make changes');   // lapses inside the wait before a save
    await new Promise((r) => setTimeout(r, 1200));                                                         // then the app dies: no unmount, no page-hide
    expect(sent).toEqual([]);
    await restartKeptText();
    const { EditField: Fresh } = await import('../../src/ui/editField');
    const crashed = document.createElement('div'); document.body.appendChild(crashed);
    await act(() => { render(<Fresh keep="q6:text" label="Response" multiline value="As saved" rev={1} commit={commit} />, crashed); });
    expect(crashed.querySelector('textarea')!.value).toBe('Typed just before');
    await act(() => { render(null, crashed); render(null, host); }); localStorage.clear();
  });

  /** A host that plans each save when the test lets it go, from the record as it is then, refusing as the Store does when the record moved on */
  function queued(initial: string, keep?: string, multiline = false) {
    const host = document.createElement('div'); document.body.appendChild(host);
    const rec = { value: initial, rev: 1 }; let wrote: string | undefined; const sent: { v: string; over: string; go: (away?: boolean) => void }[] = [];
    const commit = (v: string, over: string) => new Promise<{ ok: boolean; error?: { kind: string; message: string } }>((res) => sent.push({ v, over, go: (away?: boolean) => {
      if (away) return res({ ok: false, error: { kind: 'unreachable', message: 'The Punchlist folder cannot be written to' } });
      if (rec.value !== over && rec.value !== wrote) return res({ ok: false, error: { kind: 'conflict', message: CHANGED_ELSEWHERE } });
      if (rec.value !== v) { rec.value = v; rec.rev++; wrote = v; } res({ ok: true });
    } }));
    const draw = (locked: string | null = null) => act(() => {
      render(<ReadOnlyContext.Provider value={locked}>
        <EditField label="Counterparty" keep={keep} multiline={multiline} value={rec.value}
          rev={rec.rev} commit={commit} debounceMs={20} />
      </ReadOnlyContext.Provider>, host);
    });
    const el = () => host.querySelector(multiline ? 'textarea' : 'input') as HTMLInputElement;
    const typeBlur = (v: string) => act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); el().dispatchEvent(new FocusEvent('blur')); });
    const go = async (i: number, away?: boolean) => { await act(async () => { sent[i].go(away); }); await draw(); };
    const elsewhere = async (v: string) => { rec.value = v; rec.rev++; await draw(); };
    return { host, rec, sent, draw, el, unmount: () => act(() => { render(null, host); }), typeBlur, go, elsewhere, button: (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === t)! };
  }

  it.each([
    ['The deal has two versions. Choose one first.', 'deal:unlock-after-conflict'],
    ['Sign in to Intelligence to make changes', 'deal:unlock-after-sign-in'],
  ])('waits for Retry on a reopened field after clearing "%s"', async (reason, keep) => {
    const original = 'The borrower under the signed agreement';
    const kept = 'The guarantor named in the accession deed';
    const f = queued(original, keep);
    await f.draw();
    await f.typeBlur(kept);
    await f.go(0, true);
    await f.unmount();
    await f.draw();
    expect(f.button('Not saved · Retry')).toBeDefined();

    await f.draw(reason);
    expect(f.el().readOnly).toBe(true);
    await f.draw();
    expect(f.sent.map(({ v }) => v)).toEqual([kept]);
    expect(f.rec.value).toBe(original);
    expect(f.el().value).toBe(kept);

    await act(async () => { f.button('Not saved · Retry').click(); });
    expect(f.sent[1]).toMatchObject({ v: kept, over: original });
    await f.go(1);
    expect(f.rec.value).toBe(kept);
    await f.unmount();
  });

  it('several changes read at once while the field\'s save is out, value unchanged, then the save fails: "Changed elsewhere", not Retry', async () => {
    const f = queued('abc'); await f.draw();
    await f.typeBlur('mine');
    f.rec.rev += 2; await f.draw();                                             // changed and put back by two PCs, read in one sync
    await f.go(0, true);
    expect(f.el().value).toBe('mine'); expect(f.host.textContent).toMatch(/Changed elsewhere/); expect(f.host.textContent).not.toMatch(/Not saved/);
    expect(f.rec.value).toBe('abc'); expect(f.sent.length).toBe(1);
  });
  it('a change and its put-back read in two syncs while the field\'s save is out, then the save fails: "Changed elsewhere", and a reconnect sends nothing', async () => {
    const f = queued('abc'); await f.draw();
    await f.typeBlur('mine');
    await f.elsewhere('pc2 wording'); await f.elsewhere('abc');                // changed, then put back, each read in its own sync
    await f.go(0, true);
    expect(f.el().value).toBe('mine'); expect(f.host.textContent).toMatch(/Changed elsewhere/); expect(f.host.textContent).not.toMatch(/Not saved/);
    await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(f.rec.value).toBe('abc'); expect(f.sent.length).toBe(1);
    await f.unmount();
  });
  it('asked only because of a jump while its save was out, the field goes back to saving once that save lands', async () => {
    const f = queued('abc'); await f.draw();
    await f.typeBlur('mine');
    f.rec.rev += 2; await f.draw();                                             // two versions in one sync, value unchanged
    await f.typeBlur('mine 2'); await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    expect(f.host.textContent).toMatch(/Changed elsewhere/); expect(f.sent.length).toBe(1);
    await f.go(0); await act(() => new Promise<void>((r) => setTimeout(r, 30))); await f.draw();   // the first save lands
    expect(f.host.textContent).not.toMatch(/Changed elsewhere/); expect(f.sent.map((x) => x.v)).toEqual(['mine', 'mine 2']);
    await f.go(1); await act(() => new Promise<void>((r) => setTimeout(r, 30))); await f.draw();
    expect(f.rec.value).toBe('mine 2'); expect(f.host.textContent).not.toMatch(/Changed elsewhere|Not saved/);
    await f.unmount();
  });
  it('several changes read at once while the field holds no text of its own are followed: text kept later still says "Not saved · Retry"', async () => {
    const f = queued('abc', 'zz:jump'); await f.draw();
    f.rec.rev += 2; await f.draw(); expect(f.host.textContent).not.toMatch(/Changed elsewhere/);
    await f.typeBlur('mine'); await f.go(0, true); await f.unmount(); await f.draw();
    expect(f.el().value).toBe('mine'); expect(f.host.textContent).toMatch(/Not saved · Retry/); expect(f.host.textContent).not.toMatch(/Changed elsewhere/);
    await f.unmount(); localStorage.clear();
  });

  it('a second save sent while the first is out is typed over what the field last took, and is refused when another PC\'s change synced in between: the person chooses', async () => {
    const f = queued(''); await f.draw();
    await f.typeBlur('Contoso'); await f.typeBlur('Contoso B');
    expect(f.sent.map((x) => [x.v, x.over])).toEqual([['Contoso', ''], ['Contoso B', '']]);
    await f.go(0);                                                 // the first is written and comes back
    await f.elsewhere('Theirs');                                   // another PC's change syncs in before the second's turn
    await f.go(1);
    expect(f.rec.value).toBe('Theirs'); expect(f.el().value).toBe('Contoso B');
    expect(f.host.textContent).toMatch(/Changed elsewhere/); expect(f.host.textContent).not.toMatch(/Not saved/);
    await act(async () =>
      { f.button('Keep Mine').click(); });     // the person keeps theirs out: sent over the value they were shown
    expect(f.sent[2]).toMatchObject({ v: 'Contoso B', over: 'Theirs' });
    await f.go(2); await act(() => new Promise<void>((r) => setTimeout(r, 10))); await f.draw();
    expect(f.rec.value).toBe('Contoso B'); expect(f.host.textContent).not.toMatch(/Changed elsewhere|Not saved/);
  });

  it('Keep mine refused because a newer change came in still offers the choice; Take theirs refused takes the newer one', async () => {
    const f = queued('abc'); await f.draw();
    await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); f.el().value = 'mine'; f.el().dispatchEvent(new Event('input', { bubbles: true })); });
    await f.elsewhere('theirs v1'); expect(f.host.textContent).toMatch(/Changed elsewhere/);
    await act(async () => { f.button('Keep Mine').click(); });
    await f.elsewhere('theirs v2'); await f.go(0);                 // a newer change arrived before Keep mine's turn
    expect(f.rec.value).toBe('theirs v2'); expect(f.el().value).toBe('mine'); expect(f.host.textContent).toMatch(/Changed elsewhere/);
    await act(async () => { f.button('Take Theirs').click(); });
    expect(f.el().value).toBe('theirs v2'); expect(f.host.textContent).not.toMatch(/Changed elsewhere|Not saved/);
    expect(f.sent.length).toBe(1);                                 // nothing waits, so Take theirs sends nothing
  });
  it('Take theirs over a save that could not be written, refused because a newer change came in, follows the newer one and still settles the waiting save', async () => {
    const f = queued('abc'); await f.draw();
    await f.typeBlur('mine'); await f.go(0, true);                 // could not be written: it waits
    expect(f.host.textContent).toMatch(/Not saved/);
    await f.elsewhere('theirs v1'); expect(f.host.textContent).toMatch(/Changed elsewhere/);
    await act(async () => { f.button('Take Theirs').click(); });
    expect(f.sent[1]).toMatchObject({ v: 'theirs v1', over: 'theirs v1' });
    await f.elsewhere('theirs v2'); await f.go(1);                 // refused: the record moved on before its turn
    expect(f.el().value).toBe('theirs v2'); expect(f.rec.value).toBe('theirs v2');
    expect(f.sent[2]).toMatchObject({ v: 'theirs v2', over: 'theirs v2' });   // sent again with the newer value: nothing to write, the waiting save is let go
    await f.go(2); expect(f.rec.value).toBe('theirs v2'); expect(f.host.textContent).not.toMatch(/Changed elsewhere|Not saved/);
  });
  it('Take theirs makes theirs what the next typing is over, and a later Escape does not put the old value back over it', async () => {
    const f = queued('abc'); await f.draw();
    await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); f.el().value = 'mine'; f.el().dispatchEvent(new Event('input', { bubbles: true })); });
    await f.elsewhere('theirs');
    await act(async () => { f.button('Take Theirs').click(); }); await f.draw();
    expect(f.el().value).toBe('theirs');
    await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await f.draw();
    expect(f.sent).toEqual([]); expect(f.el().value).toBe('theirs');
    await f.typeBlur('theirs X'); expect(f.sent[0]).toMatchObject({ v: 'theirs X', over: 'theirs' });
    await f.go(0); expect(f.rec.value).toBe('theirs X'); expect(f.host.textContent).not.toMatch(/Changed elsewhere/);
  });
  it('Escape in a one-line field that followed a change from elsewhere does not put the old value back over it', async () => {
    const f = queued('abc'); await f.draw();
    await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); });
    await f.elsewhere('theirs'); expect(f.el().value).toBe('theirs');
    await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await f.draw();
    expect(f.sent).toEqual([]); expect(f.rec.value).toBe('theirs'); expect(f.el().value).toBe('theirs');
  });
  it('after a refused save the field followed, a later Escape does not put the old value back over theirs', async () => {
    const g = queued('abc'); await g.draw();
    await act(() => { g.el().dispatchEvent(new FocusEvent('focus')); g.el().value = 'abcX'; g.el().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await act(() => { g.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });   // the person's own edit taken back
    await g.elsewhere('theirs'); await g.go(0); await g.go(1); expect(g.el().value).toBe('theirs');
    await act(() => { g.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await g.draw();
    expect(g.sent.length).toBe(2); expect(g.rec.value).toBe('theirs');
  });
  it('a refused save in a one-line field: Escape keeps the text and the choice, and after leaving and coming back it is still Changed elsewhere, never a Retry over theirs', async () => {
    const f = queued('abc', 'zz:one'); await f.draw();
    await f.typeBlur('mine'); await f.elsewhere('theirs'); await f.go(0);       // the save waited, theirs synced in, the save is refused
    expect(f.host.textContent).toMatch(/Changed elsewhere/);
    await act(() => { f.el().focus(); f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await f.draw();
    expect(f.el().value).toBe('mine'); expect(f.host.textContent).toMatch(/Changed elsewhere/);
    await f.unmount(); await f.draw();                                          // the person leaves the question and comes back
    expect(f.el().value).toBe('mine'); expect(f.host.textContent).toMatch(/Changed elsewhere/); expect(f.host.textContent).not.toMatch(/Not saved/);
    expect(f.rec.value).toBe('theirs'); expect(f.sent.length).toBe(1);
    await f.unmount(); localStorage.clear();
  });

  it('Escape on Changed elsewhere in a text box keeps the typed text and the choice, and goes on to close what holds it', async () => {
    const f = queued('abc', 'zz:box', true); await f.draw();
    await f.typeBlur('a long passage'); await f.elsewhere('theirs'); await f.go(0);
    let closed = false; const close = () => { closed = true; }; f.host.addEventListener('keydown', close);
    await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await f.draw();
    expect({ text: f.el().value, closed, rec: f.rec.value }).toEqual({ text: 'a long passage', closed: true, rec: 'theirs' });
    expect(f.host.textContent).toMatch(/Changed elsewhere/);
    await f.unmount(); localStorage.clear();
  });
  it('Escape while the field is read-only does not take a change from elsewhere over the typed text', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const rec = { value: 'abc', rev: 1 };
    const draw = (lock: string | null) => act(() => { render(<ReadOnlyContext.Provider value={lock}><EditField label="Counterparty" value={rec.value} rev={rec.rev} commit={async () => ({ ok: true })} debounceMs={500} /></ReadOnlyContext.Provider>, host); });
    await draw(null); const el = host.querySelector('input')!;
    await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'typed before lock'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await draw('Read only for now'); rec.value = 'theirs'; rec.rev++; await draw('Read only for now');
    await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(el.value).toBe('typed before lock');
    await act(() => { render(null, host); });
  });

  describe('kept text shown again after another PC changed the field', () => {
    const unreachable = () => Promise.resolve({ ok: false, error: { kind: 'unreachable', message: 'The Punchlist folder is out of reach' } });
    /** type into a field whose save fails, then move on: the text is kept as not saved */
    async function typedAndLeft(keep: string, typed: string, record = 'A: the original text', store?: { get(): any; subscribe(fn: () => void): () => void }) {
      localStorage.clear();
      await restartKeptText();
      const { EditField: First } = await import('../../src/ui/editField'); const { StoreContext } = await import('../../src/ui/hooks');
      const host = document.createElement('div'); document.body.appendChild(host);
      // with a store, the field reads itself from it as the app's fields do, so its kept text is watched once it goes
      const field = <First keep={keep} label="Question" multiline value={record} rev={1} commit={unreachable} debounceMs={20} read={(s: any) => s.q} />;
      await act(() => { render(store ? <StoreContext.Provider value={store as any}>{field}</StoreContext.Provider> : field, host); });
      const el = host.querySelector('textarea')!;
      await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = typed; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(() => new Promise((r) => setTimeout(r, 60)));
      expect(host.textContent).toMatch(/Not saved/);
      await act(() => { render(store ? <StoreContext.Provider value={store as any}><span /></StoreContext.Provider> : null, host); });
      return { host, Same: First };
    }

    it('shows "Changed elsewhere · Keep mine / Take theirs", not Retry, and sends nothing until the person chooses', async () => {
      const { host, Same } = await typedAndLeft('qE:text', 'A mine');
      const sent: string[] = []; const commit = async (v: string) => { sent.push(v); return { ok: true }; };
      await act(() => { render(<Same keep="qE:text" label="Question" multiline value="C theirs" rev={2} commit={commit} />, host); });
      expect(host.querySelector('textarea')!.value).toBe('A mine');                            // the person's text is kept
      expect(host.textContent).toMatch(/Changed elsewhere/); expect(host.textContent).not.toMatch(/Retry/);
      window.dispatchEvent(new Event(CONNECTED)); await act(() => { host.querySelector('textarea')!.dispatchEvent(new FocusEvent('blur')); });
      await act(() => new Promise((r) => setTimeout(r, 60)));
      expect(sent).toEqual([]);                                                                 // not on reconnect, not on blur
      await act(() => { (([...host.querySelectorAll('button')].find((b) => b.textContent === 'Keep Mine'))!).click();
        });
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(sent).toEqual(['A mine']);                                                         // the person chose
      await act(() => { render(null, host); }); localStorage.clear();
    });

    it('after a restart too: the record the text was typed over is kept with it', async () => {
      const { host } = await typedAndLeft('qF:text', 'F mine');
      await new Promise((r) => setTimeout(r, 500));                                             // written to local storage
      await restartKeptText();
      const { EditField: Fresh } = await import('../../src/ui/editField');
      const sent: string[] = []; const commit = async (v: string) => { sent.push(v); return { ok: true }; };
      await act(() => { render(<Fresh keep="qF:text" label="Question" multiline value="F theirs" rev={5} commit={commit} />, host); });
      expect(host.querySelector('textarea')!.value).toBe('F mine'); expect(host.textContent).toMatch(/Changed elsewhere/);
      await act(() => { (([...host.querySelectorAll('button')].find((b) => b.textContent === 'Take Theirs'))!).click();
        });
      expect(host.querySelector('textarea')!.value).toBe('F theirs'); expect(sent).toEqual([]);
      await act(() => { render(null, host); }); localStorage.clear();
    });

    it('still says "Not saved · Retry" when the record is as it was when the text was typed, and Retry sends it', async () => {
      // a stand-in store: the field's record, and what is told when it changes
      let state = { q: { value: 'A: the original text', rev: 1 } }; const told = new Set<() => void>();
      const store = { get: () => state, subscribe: (fn: () => void) => { told.add(fn); return () => { told.delete(fn); }; } };
      const { host, Same } = await typedAndLeft('qG:text', 'G mine', undefined, store);
      state = { q: { value: 'A: the original text', rev: 2 } }; for (const fn of [...told]) fn();
      const sent: string[] = []; const commit = async (v: string) => { sent.push(v); return { ok: true }; };
      await act(() => { render(<Same keep="qG:text" label="Question" multiline value="A: the original text" rev={2} commit={commit} />, host); });   // another field of the record changed: rev moved, this field did not
      expect(host.textContent).toMatch(/Not saved · Retry/); expect(host.textContent).not.toMatch(/Changed elsewhere/);
      await act(() => { (([...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Not saved')))!).click(); });
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(sent).toEqual(['G mine']);
      await act(() => { render(null, host); }); localStorage.clear();
    });

    it('a change elsewhere that lands while the field’s own save is out, then that save fails: "Changed elsewhere", and neither Retry nor the reconnect resends', async () => {
      for (const kind of ['unreachable', 'conflict']) {
        localStorage.clear();
        await restartKeptText();
        const { EditField: First } = await import('../../src/ui/editField');
        const host = document.createElement('div'); document.body.appendChild(host);
        const sent: string[] = []; let release: ((v: { ok: boolean; error?: { kind: string; message: string } }) => void) | null = null;
        const commit = (v: string) => { sent.push(v); return new Promise<{ ok: boolean; error?: { kind: string; message: string } }>((r) => { release = r; }); };
        const draw = (value: string, rev: number) => act(() => { render(<First keep="qI:text" label="Question" multiline value={value} rev={rev} commit={commit} debounceMs={20} />, host); });
        await draw('I: the original text', 1);
        const el = host.querySelector('textarea')!;
        await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'I mine'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(() => new Promise((r) => setTimeout(r, 60))); expect(sent).toEqual(['I mine']);
        await draw('I theirs', 2);                                                               // the other PC's change lands while ours is out
        await act(async () => { release!({ ok: false, error: { kind, message: 'Not saved' } }); }); await act(() => new Promise((r) => setTimeout(r, 30)));
        expect(el.value).toBe('I mine'); expect(host.textContent).toMatch(/Changed elsewhere/); expect(host.textContent).not.toMatch(/Retry/);
        await act(() => { window.dispatchEvent(new Event(CONNECTED)); el.dispatchEvent(new FocusEvent('blur')); }); await act(() => new Promise((r) => setTimeout(r, 60)));
        expect(sent).toEqual(['I mine']);                                                        // nothing more sent until the person chooses
        await act(() => { render(null, host); }); localStorage.clear();
      }
    });

    it('a change elsewhere that arrived while the field was on screen and flagged is still flagged once the field comes back', async () => {
      localStorage.clear();
      await restartKeptText();
      const { EditField: First } = await import('../../src/ui/editField');
      const host = document.createElement('div'); document.body.appendChild(host);
      const draw = (value: string, rev: number) => act(() => { render(<First keep="qH:text" label="Question" multiline value={value} rev={rev} commit={unreachable} debounceMs={20} />, host); });
      await draw('A: the original text', 1);
      const el = host.querySelector('textarea')!;
      await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'H mine'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(() => new Promise((r) => setTimeout(r, 60)));
      await draw('H theirs', 2); expect(host.textContent).toMatch(/Changed elsewhere/);
      await act(() => { render(null, host); });                                                 // the person moves on without choosing
      await act(() => { render(<First keep="qH:text" label="Question" multiline value="H theirs" rev={2} commit={unreachable} />, host); });
      expect(host.querySelector('textarea')!.value).toBe('H mine'); expect(host.textContent).toMatch(/Changed elsewhere/); expect(host.textContent).not.toMatch(/Retry/);
      await act(() => { render(null, host); }); localStorage.clear();
    });
  });
  it('a change from elsewhere found when the field\'s own trimmed save reports back: the text typed meanwhile is kept against a crash', async () => {
    localStorage.clear();
    await restartKeptText();
    const { EditField: First } = await import('../../src/ui/editField');
    const { saveKeptDrafts } = await import('../../src/app/keptText');
    const root = document.createElement('div'); document.body.appendChild(root);
    const rec = { value: 'orig', rev: 1 }; const later: (() => void)[] = [];
    const draw = () => act(() => { render(<First keep="dL:counterparty" label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, root); });
    const commit = (v: string) => { rec.value = v.trim(); rec.rev++; void draw(); return new Promise<{ ok: boolean }>((res) => later.push(() => res({ ok: true }))); };   // stored trimmed and drawn before it is heard back, as the Store does
    await draw();
    const el = () => root.querySelector('input') as HTMLInputElement;
    await act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = 'Contoso '; el().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));                               // sent, stored as "Contoso"
    await act(() => { el().value = 'Contoso Holdings Inc.'; el().dispatchEvent(new Event('input', { bubbles: true })); });
    rec.value = 'Coho'; rec.rev++; await draw();                                                 // another PC's change lands before the save reports back
    await act(async () => { later[0](); }); await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(el().value).toBe('Contoso Holdings Inc.'); expect(root.textContent).toMatch(/Changed elsewhere/); expect(rec.value).toBe('Coho');
    saveKeptDrafts(); expect(localStorage.getItem('dil/1/kept-drafts') ?? '').toContain('Contoso Holdings Inc.');   // a crash now would not lose it
    await act(() => { render(null, root); }); localStorage.clear();
  });

  it('a waiting save refused after the person typed back to what it was typed over keeps nothing, so nothing is offered over the newer value later', async () => {
    localStorage.clear();
    await restartKeptText();
    const { EditField: First } = await import('../../src/ui/editField');
    const { saveKeptDrafts } = await import('../../src/app/keptText');
    const root = document.createElement('div'); document.body.appendChild(root);
    const rec = { value: 'orig', rev: 1 }; const later: ((r: { ok: boolean; error?: { kind: string; message: string } }) => void)[] = []; let shown = true;
    const draw = () => act(() => { render(shown ? <First keep="dM:counterparty" label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} /> : null, root); });
    const commit = () => new Promise<{ ok: boolean; error?: { kind: string; message: string } }>((res) => later.push(res));   // waits its turn
    await draw();
    const el = () => root.querySelector('input') as HTMLInputElement;
    const type = (v: string) => act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
    await type('X'); await act(() => new Promise<void>((r) => setTimeout(r, 40)));               // sent, waiting
    rec.value = 'Coho'; rec.rev++; await draw();                                                 // another PC's change drawn while it waits
    await type('orig');                                                                          // typed back to what it was typed over
    await act(async () => { later[0]({ ok: false, error: { kind: 'conflict', message: CHANGED_ELSEWHERE } }); }); await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(el().value).toBe('Coho'); expect(root.textContent).not.toMatch(/Changed elsewhere|Not saved/);
    saveKeptDrafts(); expect(localStorage.getItem('dil/1/kept-drafts') ?? '').not.toContain('dM:counterparty');
    shown = false; await draw(); shown = true; await draw();
    expect(el().value).toBe('Coho'); expect(root.textContent).not.toMatch(/Changed elsewhere|Not saved/);
    await act(() => { render(null, root); }); localStorage.clear();
  });

  describe('what the field compares with stays right in ordinary use', () => {
    /** a field over a record that stores what is saved through `norm` (EditDeal trims, say); `shown` false takes the field off screen */
    function host(initial: string, multiline: boolean, norm = (v: string) => v) {
      const el0 = document.createElement('div'); document.body.appendChild(el0);
      const rec = { value: initial, rev: 1 }; const commits: { v: string; resolve: (ok: boolean) => void }[] = [];
      const commit = (v: string) => new Promise<{ ok: boolean; error?: { kind: string; message: string } }>((res) => commits.push({ v, resolve: (ok) => { if (ok) { rec.value = norm(v); rec.rev++; } res(ok ? { ok } : { ok, error: { kind: 'unreachable', message: 'Not saved' } }); } }));
      let shown = true;
      const draw = () => act(() => { render(shown ? <EditField label="Question" multiline={multiline} value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} /> : null, el0); });
      draw();
      const el = () => el0.querySelector(multiline ? 'textarea' : 'input') as HTMLTextAreaElement;
      const type = (v: string) => act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
      const settle = (ms = 40) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
      return { root: el0, rec, commits, draw, el, type, settle, hide: async () => { shown = false; await draw(); }, text: () => el0.textContent ?? '' };
    }

    it('a save the app stores trimmed is this field’s own, not a change made elsewhere: typing on saves', async () => {
      const f = host('', false, (v) => v.trim());
      await f.type('Contoso '); await f.settle(); await act(async () => { f.commits[0].resolve(true); }); await f.draw(); await f.settle();
      await f.type('Contoso Corp'); await f.settle();
      expect(f.text()).not.toMatch(/Changed elsewhere/); expect(f.commits.map((c) => c.v)).toEqual(['Contoso ', 'Contoso Corp']);
    });

    it.each(['Seller under the sale agreement', ' Seller under the sale agreement '])(
      'Escape after Keep Mine restores the stored choice for %j',
      async (chosen) => {
        const stored = chosen.trim();
        const f = host('Seller under the term sheet', false, (value) => value.trim());
        const input = (value: string) => act(() => {
          f.el().value = value;
          f.el().dispatchEvent(new Event('input', { bubbles: true }));
        });
        const pressEscape = () => act(() => {
          f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

        await f.type(chosen);
        f.rec.value = 'Seller under the transfer agreement';
        f.rec.rev++;
        await f.draw();
        const keep = [...f.root.querySelectorAll('button')].find((button) => button.textContent === 'Keep Mine')!;
        await act(() => { keep.click(); });
        await input('Seller under the amended sale agreement');
        await pressEscape();
        expect(f.el().value).toBe('Seller under the amended sale agreement');
        expect(f.commits.map(({ v }) => v)).toEqual([chosen]);
        await act(async () => { f.commits[0].resolve(true); });
        await f.draw();
        await f.settle(0);
        expect(f.el().value).toBe('Seller under the amended sale agreement');

        await pressEscape();
        await f.settle();
        expect(f.el().value).toBe(stored);
        expect(f.rec.value).toBe(stored);
        expect(f.commits.map(({ v }) => v)).toEqual([chosen]);
        await f.hide();
      },
    );

    it('Escape on "Changed elsewhere" keeps the typed text, leaves the choice open and closes what holds the field', async () => {
      const f = host('abc', false); let closed = 0;
      const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closed++; }; document.addEventListener('keydown', onEsc);
      await f.type('mine'); f.rec.value = 'theirs'; f.rec.rev++; await f.draw();
      await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await f.draw();
      document.removeEventListener('keydown', onEsc);
      expect([f.el().value, closed]).toEqual(['mine', 1]); expect(f.text()).toMatch(/Changed elsewhere/); expect(f.commits).toEqual([]);
    });

    it('the person’s own save, stored trimmed and heard back after they left, is not a change elsewhere when the field comes back', async () => {
      localStorage.clear();
      await restartKeptText();
      const { EditField: First } = await import('../../src/ui/editField');
      const root = document.createElement('div'); document.body.appendChild(root);
      const rec = { value: '', rev: 1 }; const sent: string[] = []; const later: (() => void)[] = []; let shown = true;
      const draw = () => act(() => { render(shown ? <First keep="dK:counterparty" label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} /> : null, root); });
      const commit = (v: string) => { sent.push(v); rec.value = v.trim(); rec.rev++; void draw(); return new Promise<{ ok: boolean }>((res) => later.push(() => res({ ok: true }))); };   // stored trimmed and drawn, as the Store does, before it is heard back
      await draw();
      const el = () => root.querySelector('input') as HTMLInputElement;
      await act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = 'Contoso '; el().dispatchEvent(new Event('input', { bubbles: true })); });
      await act(() => new Promise<void>((r) => setTimeout(r, 40)));
      await act(() => { el().value = 'Contoso Corp'; el().dispatchEvent(new Event('input', { bubbles: true })); });
      shown = false; await draw();                                                             // leaves before the save is heard back
      await act(async () => { later[0](); }); await act(() => new Promise<void>((r) => setTimeout(r, 30)));
      shown = true; await draw();
      expect(el().value).toBe('Contoso Corp'); expect(root.textContent).not.toMatch(/Changed elsewhere/); expect(root.textContent).toMatch(/Not saved/);
      await act(() => { render(null, root); }); localStorage.clear();
    });

    it('leaving the screen does not send text over a change that landed while the field’s own save was out', async () => {
      const f = host('abc', true);
      await f.type('abcd'); await f.settle();                                                   // a save out
      f.rec.value = 'theirs'; f.rec.rev++; await f.draw();                                      // another PC
      await f.type('abcde'); await f.hide();                                                    // the debounce still waiting
      expect(f.commits.map((c) => c.v)).toEqual(['abcd']);
    });

    it('a change elsewhere that lands after the field’s own save is applied, before it hears back, is still asked about, kept text too', async () => {
      // the Store's order: a save that is written is applied (the field is drawn with it) before the caller hears back
      localStorage.clear();
      await restartKeptText();
      const { EditField: First } = await import('../../src/ui/editField');
      const root = document.createElement('div'); document.body.appendChild(root);
      const rec = { value: 'abc', rev: 1 }; const sent: string[] = []; const later: (() => void)[] = [];
      let shown = true; let fail = false;
      const draw = () => act(() => { render(shown ? <First keep="qJ:text" label="Question" multiline value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} /> : null, root); });
      const commit = (v: string) => { sent.push(v); if (fail) return new Promise<{ ok: boolean; error?: { kind: string; message: string } }>((res) => later.push(() => res({ ok: false, error: { kind: 'unreachable', message: 'Not saved' } }))); rec.value = v; rec.rev++; void draw(); return new Promise<{ ok: boolean }>((res) => later.push(() => res({ ok: true }))); };
      await draw();
      const el = () => root.querySelector('textarea') as HTMLTextAreaElement;
      const type = (v: string) => act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
      const wait = (ms = 40) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
      await type('abcd'); await wait();                                                         // applied as 'abcd'; not heard back yet
      fail = true; await type('abcde'); await wait();                                           // a second save, which fails when it is heard back
      rec.value = 'theirs'; rec.rev++; await draw();                                            // another PC, before the first save is heard back
      await act(async () => { later[0](); }); await wait();
      await act(async () => { later[1](); }); await wait();
      expect(el().value).toBe('abcde'); expect(root.textContent).toMatch(/Changed elsewhere/); expect(root.textContent).not.toMatch(/Retry/);
      await act(() => { window.dispatchEvent(new Event(CONNECTED)); }); await wait();
      shown = false; await draw(); shown = true; await draw();                                  // the field goes and comes back
      expect(el().value).toBe('abcde'); expect(root.textContent).toMatch(/Changed elsewhere/);
      expect(sent).toEqual(['abcd', 'abcde']);                                                  // nothing sent over the other PC's text
      await act(() => { render(null, root); }); localStorage.clear();
    });

    it('a save with nothing to write does not take a change elsewhere that landed meanwhile as its own', async () => {
      const root = document.createElement('div'); document.body.appendChild(root);
      const rec = { value: 'Contoso', rev: 1 }; let hear: (() => void) | null = null; const sent: string[] = [];
      const commit = (v: string) => { sent.push(v); return new Promise<{ ok: boolean; value?: { unchanged?: boolean } }>((res) => { hear = () => res({ ok: true, value: { unchanged: true } }); }); };   // the app trims it: the record already holds it
      const draw = () => act(() => { render(<EditField label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, root); });
      await draw();
      const el = () => root.querySelector('input') as HTMLInputElement;
      await act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = 'Contoso '; el().dispatchEvent(new Event('input', { bubbles: true })); });
      await act(() => new Promise<void>((r) => setTimeout(r, 40)));
      rec.value = 'Contoso Holdings'; rec.rev++; await draw();                                    // another PC, while the save is out
      await act(async () => { hear!(); }); await act(() => new Promise<void>((r) => setTimeout(r, 30)));
      expect(root.textContent).toMatch(/Changed elsewhere/); expect(el().value).toBe('Contoso ');
      await act(() => { el().value = 'Contoso Corp'; el().dispatchEvent(new Event('input', { bubbles: true })); }); await act(() => new Promise<void>((r) => setTimeout(r, 40)));
      expect(sent).toEqual(['Contoso ']);
      await act(() => { render(null, root); });
    });

    it('Keep mine clears the prompt when the record already holds the field’s text', async () => {
      const f = host('abc', true);
      await f.type('abcd'); await f.settle(); await f.type('abcde'); await f.settle();          // two saves out
      f.rec.value = 'theirs'; f.rec.rev++; await f.draw();
      await act(async () => { f.commits[0].resolve(false); }); await f.draw();
      await act(async () => { f.commits[1].resolve(true); }); await f.draw(); await f.settle();
      expect(f.text()).toMatch(/Changed elsewhere/);
      const keep = [...f.root.querySelectorAll('button')].find((b) => b.textContent === 'Keep Mine')!;
      await act(async () => { keep.click(); }); await f.settle();
      expect(f.text()).not.toMatch(/Changed elsewhere/); expect(f.el().value).toBe('abcde');
    });
  });
  it('a text box closed by Escape on Changed elsewhere comes back still Changed elsewhere, with no Retry to write over theirs', async () => {
    for (const refused of [true, false]) {
      const f = queued('orig', `zz:box-${refused}`, true); await f.draw();
      if (refused) { await f.typeBlur('a long passage'); await f.elsewhere('theirs'); await f.go(0); }   // the save waited and was refused
      else { await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); f.el().value = 'a long passage'; f.el().dispatchEvent(new Event('input', { bubbles: true })); }); await f.elsewhere('theirs'); }   // theirs came in before the debounce
      await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      await f.unmount(); await f.draw();
      expect({ text: f.el().value, rec: f.rec.value }).toEqual({ text: 'a long passage', rec: 'theirs' });
      expect(f.host.textContent).toMatch(/Changed elsewhere/); expect(f.host.textContent).not.toMatch(/Not saved/);
      await f.unmount(); localStorage.clear();
    }
  });

  describe('Escape on text that was not saved on entry, and a failed save meeting a change from elsewhere', () => {
    /** a one-line field over a record the host changes; `reach` false makes every save fail as the folder out of reach */
    function field(initial: string, keep: string) {
      const host = document.createElement('div'); document.body.appendChild(host);
      const rec = { value: initial, rev: 1 }; const sent: string[] = []; let reach = false; let shown = true;
      // as the Store does, a save that is written is drawn before its caller hears back
      const commit = async (v: string) => { sent.push(v); if (!reach) return { ok: false, error: { kind: 'unreachable', message: 'The Punchlist folder is out of reach' } }; rec.value = v; rec.rev++; paint(); return { ok: true }; };
      const paint = () => { render(shown ? <EditField keep={keep} label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} /> : null, host); };
      const draw = () => act(paint);
      const el = () => host.querySelector('input') as HTMLInputElement;
      const input = (v: string) => act(() => { el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
      const focus = () => act(() => { el().dispatchEvent(new FocusEvent('focus')); });
      const pressEscape = () => act(() => { el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
      return { host, rec, sent, draw, el, input, focus, pressEscape, settle, reachable: (v: boolean) => { reach = v; }, show: async (v: boolean) => { shown = v; await draw(); }, text: () => host.textContent ?? '' };
    }

    it('kept "Not saved" text, typed on and then Escape: back to the kept text, still Not saved with its Retry, and nothing is written', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:esc-kept'); await f.draw();
      await f.focus(); await f.input('kept text'); await f.settle();
      expect(f.text()).toMatch(/Not saved · Retry now/);
      await f.show(false); f.reachable(true); await f.show(true);                                      // left the page; the folder is back
      expect(f.el().value).toBe('kept text'); expect(f.text()).toMatch(/Not saved · Retry$/);
      await f.focus(); await f.input('kept text and more'); await f.pressEscape(); await f.draw(); await f.settle();
      expect({ text: f.el().value, rec: f.rec.value, sent: f.sent }).toEqual({ text: 'kept text', rec: 'orig', sent: ['kept text'] });   // only the first, failed, save
      expect(f.text()).toMatch(/Not saved · Retry$/);
      await f.show(false); await f.show(true);                                                          // still kept as it was
      expect(f.el().value).toBe('kept text'); expect(f.text()).toMatch(/Not saved · Retry$/);
      await act(async () => { (f.host.querySelector('.efstate.fail') as HTMLButtonElement).click(); }); await f.draw(); await f.settle();
      expect(f.rec.value).toBe('kept text'); expect(f.text()).not.toMatch(/Not saved/);                // the person chose to send it
      await f.show(false); localStorage.clear();
    });

    it('if part of that edit was already saved, Escape sends back what was saved on entry and shows the kept text Not saved again', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:esc-partial'); await f.draw();
      await f.focus(); await f.input('kept text'); await f.settle();
      await f.show(false); f.reachable(true); await f.show(true);
      await f.focus(); await f.input('kept text and more'); await f.settle(); await f.draw();          // the debounce saved it
      expect(f.rec.value).toBe('kept text and more');
      await f.input('kept text and more, still'); await f.pressEscape(); await f.draw(); await f.settle(); await f.draw();
      expect({ text: f.el().value, rec: f.rec.value }).toEqual({ text: 'kept text', rec: 'orig' });
      expect(f.sent).toEqual(['kept text', 'kept text and more', 'orig']);
      expect(f.text()).toMatch(/Not saved · Retry$/);
      await f.show(false); await f.show(true);
      expect(f.el().value).toBe('kept text'); expect(f.text()).toMatch(/Not saved · Retry$/);
      await f.show(false); localStorage.clear();
    });

    it('a field showing kept text that is only focused and left, or put back by Escape and left, sends nothing', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:esc-blur'); await f.draw();
      await f.focus(); await f.input('kept text'); await f.settle();
      await f.show(false); f.reachable(true); await f.show(true);
      await f.focus(); await act(() => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle();
      await f.focus(); await f.input('kept text, more'); await f.pressEscape(); await act(() => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle();
      expect({ text: f.el().value, rec: f.rec.value, sent: f.sent }).toEqual({ text: 'kept text', rec: 'orig', sent: ['kept text'] });
      expect(f.text()).toMatch(/Not saved · Retry$/);
      await f.focus(); await f.input('kept text, more'); await act(() => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle(); await f.draw();
      expect(f.rec.value).toBe('kept text, more');                                                     // an edit is still sent on leaving, as always
      await f.show(false); localStorage.clear();
    });

    it('text typed and deleted back to the kept text is an edit: leaving sends it, so nothing is left with no status', async () => {
      for (const multiline of [false, true]) {
        localStorage.clear();
        const host = document.createElement('div'); document.body.appendChild(host);
        const rec = { value: 'orig', rev: 1 }; const sent: string[] = []; let reach = false;
        const commit = async (v: string) => { sent.push(v); if (!reach) return { ok: false, error: { kind: 'unreachable', message: 'x' } }; rec.value = v; rec.rev++; paint(); return { ok: true }; };
        const paint = () => { render(<EditField keep={`zz:back-${multiline}`} multiline={multiline} label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, host); };
        const el = () => host.querySelector(multiline ? 'textarea' : 'input') as HTMLInputElement;
        const input = (v: string) => act(() => { el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
        const wait = () => act(() => new Promise<void>((r) => setTimeout(r, 60)));
        await act(paint); await act(() => { el().dispatchEvent(new FocusEvent('focus')); }); await input('X'); await wait();
        await act(() => { el().dispatchEvent(new FocusEvent('blur')); }); await wait();
        reach = true; await act(() => { el().dispatchEvent(new FocusEvent('focus')); });              // back in while it says Not saved; the folder is back
        await input('X more'); await wait(); expect(rec.value).toBe('X more');                       // the debounce saved it
        await input('X'); await act(() => { el().dispatchEvent(new FocusEvent('blur')); }); await wait();
        expect({ rec: rec.value, text: el().value }).toEqual({ rec: 'X', text: 'X' });               // sent on leaving, as before
        expect(host.textContent).not.toMatch(/Not saved/);
        await act(() => { render(null, host); });
      }
      localStorage.clear();
    });

    it('Escape after the edit\'s own save failed sends back what was saved on entry, so that save is settled, and the field still says plain Retry: nothing is sent by itself on reconnect', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:esc-failed'); await f.draw();
      await f.focus(); await f.input('kept text'); await f.settle();
      await f.show(false); await f.show(true);                                                          // folder still away
      expect(f.text()).toMatch(/Not saved · Retry$/);
      await f.focus(); await f.input('kept text and more'); await f.settle();                         // the edit's save fails too
      await f.pressEscape(); await f.draw(); await f.settle();
      expect(f.sent).toEqual(['kept text', 'kept text and more', 'orig']);                             // the record's own value: tells the app the failed save is not wanted
      expect(f.el().value).toBe('kept text'); expect(f.text()).toMatch(/Not saved · Retry$/);
      f.reachable(true); await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await f.settle(); await f.draw();
      expect(f.rec.value).toBe('orig'); expect(f.sent.length).toBe(3);
      await f.show(false); await f.show(true); expect(f.el().value).toBe('kept text');
      await f.show(false); localStorage.clear();
    });

    it('once the text on entry is saved (Retry now, on reconnect), Escape takes the later edit back to it and does not undo that save', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:esc-resent'); await f.draw();
      await f.focus(); await f.input('kept text'); await f.settle();
      await act(() => { f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle(); await f.focus();   // came back into the field while it says Not saved
      expect(f.text()).toMatch(/Retry now/);
      f.reachable(true); await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await f.settle(); await f.draw();
      expect(f.rec.value).toBe('kept text');
      await f.input('kept text more'); await f.pressEscape(); await f.draw(); await f.settle(); await f.draw();
      expect({ text: f.el().value, rec: f.rec.value }).toEqual({ text: 'kept text', rec: 'kept text' });
      expect(f.text()).not.toMatch(/Not saved/);
      await f.show(false); localStorage.clear();
    });

    it('an edit whose save failed while the person typed on, taken back by Escape, does not come back later as Not saved', async () => {
      for (const back of [true, false]) {                                                               // the folder back by the Escape, or still away
        localStorage.clear();
        const f = field('orig', `zz:esc-typing-${back}`); await f.draw();
        await f.focus(); await f.input('typed'); await f.settle();                                      // still in the field: its save failed
        expect(f.text()).toMatch(/Not saved/);
        await f.input('typed more'); f.reachable(back); await f.pressEscape(); await f.draw(); await f.settle(); await f.draw();
        expect({ text: f.el().value, rec: f.rec.value }).toEqual({ text: 'orig', rec: 'orig' });
        await f.show(false); await f.show(true);                                                        // the panel closed and opened again
        expect(f.el().value).toBe('orig'); expect(f.text()).not.toMatch(/Not saved|Changed elsewhere/);
        await f.show(false);
      }
      localStorage.clear();
    });

    it('a resend that the app stores trimmed, or that has nothing to write, is the field\'s own save: a later Escape does not take it back', async () => {
     for (const start of ['orig', 'Contoso Corp']) {
      localStorage.clear();
      const host = document.createElement('div'); document.body.appendChild(host);
      const rec = { value: start, rev: 1 }; const sent: string[] = []; let reach = false;
      const commit = async (v: string) => { sent.push(v); if (!reach) return { ok: false, error: { kind: 'unreachable', message: 'x' } }; const t = v.trim(); const unchanged = t === rec.value; if (!unchanged) { rec.value = t; rec.rev++; paint(); } return { ok: true, value: { unchanged } }; };
      const paint = () => { render(<EditField keep="zz:trim" label="Counterparty" value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, host); };
      const el = () => host.querySelector('input') as HTMLInputElement;
      const input = (v: string) => act(() => { el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); });
      const wait = () => act(() => new Promise<void>((r) => setTimeout(r, 60)));
      await act(paint); await act(() => { el().dispatchEvent(new FocusEvent('focus')); }); await input('Contoso Corp '); await wait();
      await act(() => { el().dispatchEvent(new FocusEvent('blur')); }); await wait();
      await act(() => { el().dispatchEvent(new FocusEvent('focus')); });                               // back in while it says Not saved · Retry now
      reach = true; await act(async () => { window.dispatchEvent(new Event(CONNECTED)); }); await wait();
      expect(rec.value).toBe('Contoso Corp');                                                               // the resend went through, stored trimmed
      await input('Contoso Corp x'); await act(() => { el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await wait(); await act(paint);
      expect(rec.value).toBe('Contoso Corp'); expect(sent).not.toContain('orig'); expect(host.textContent).not.toMatch(/Not saved/);
      await act(() => { render(null, host); }); localStorage.clear();
     }
    });

    it('Enter on kept "Not saved" text sends it: it is the person\'s choice, unlike leaving the field', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:enter'); await f.draw();
      await f.focus(); await f.input('kept text'); await f.settle();
      await f.show(false); f.reachable(true); await f.show(true);
      await f.focus(); await act(() => { f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); f.el().dispatchEvent(new FocusEvent('blur')); }); await f.settle(); await f.draw();
      expect(f.rec.value).toBe('kept text'); expect(f.text()).not.toMatch(/Not saved/);
      await f.show(false); localStorage.clear();
    });

    it('Escape on a field that held saved text on entry still undoes the edit as before', async () => {
      localStorage.clear();
      const f = field('orig', 'zz:esc-plain'); f.reachable(true); await f.draw();
      await f.focus(); await f.input('origxx'); await f.pressEscape(); await f.draw(); await f.settle();
      expect({ text: f.el().value, rec: f.rec.value, sent: f.sent }).toEqual({ text: 'orig', rec: 'orig', sent: [] });
      expect(f.text()).not.toMatch(/Not saved|Changed elsewhere/);
      await f.show(false); localStorage.clear();
    });

    it('a failed save then a change from elsewhere shows only "Changed elsewhere · Keep mine / Take theirs", not a Retry that does nothing', async () => {
      for (const multiline of [false, true]) {
        const host = document.createElement('div'); document.body.appendChild(host); const rec = { value: 'orig', rev: 1 }; const sent: string[] = [];
        const commit = async (v: string) => { sent.push(v); return { ok: false, error: { kind: 'unreachable', message: 'The Punchlist folder is out of reach' } }; };
        const draw = () => act(() => { render(<EditField label="Counterparty" multiline={multiline} value={rec.value} rev={rec.rev} commit={commit} debounceMs={20} />, host); });
        await draw(); const el = host.querySelector(multiline ? 'textarea' : 'input') as HTMLInputElement;
        await act(() => { el.dispatchEvent(new FocusEvent('focus')); el.value = 'mine'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(() => new Promise<void>((r) => setTimeout(r, 60)));
        expect(host.textContent).toMatch(/Not saved · Retry now/);
        rec.value = 'theirs'; rec.rev++; await draw();                                                  // another PC's change syncs in
        expect(host.textContent).toMatch(/Changed elsewhere/); expect(host.textContent).not.toMatch(/Not saved|Retry/);
        expect(host.querySelector('.efstate.fail')).toBeNull(); expect(el.value).toBe('mine'); expect(sent).toEqual(['mine']);
        await act(() => { render(null, host); });
      }
    });
  });
});
