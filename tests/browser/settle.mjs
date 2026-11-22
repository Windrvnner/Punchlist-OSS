/**
 * Waiting for the Q&A page to stop moving, in place of a fixed pause. On a busy machine a fixed pause can end while the deal's
 * header row is still sliding away or back, before the open question's panel has sized the list for it again, or while a wheel
 * scroll is still under way, and a check that measures then fails though the page settles a moment later.
 *
 * trackSettle(ctx) notes, in every page of the context, when the header row last tucked away or came back and when the page
 * last sized the list for it (the `qa:fit` event, 300ms after a tuck). settled(page) then waits until:
 *   - no transition or animation is running (the header row slides for 260ms),
 *   - the list has been sized again since the header last moved,
 *   - more than 400ms have passed since the header last moved: until then the page takes a scroll as the list resizing, not the
 *     person, and does not tuck or untuck for it,
 *   - and the window, the list, the open question's panel and the scroll positions have not changed for `quiet` ms.
 */
export async function trackSettle(ctx) {
  await ctx.addInitScript(() => {
    const s = (window.__settle = { tuckAt: 0, fitAt: 0, tucked: false });
    addEventListener('qa:fit', () => { s.fitAt = performance.now(); });
    new MutationObserver(() => {
      const t = !!document.querySelector('.home.qapage.tuck');
      if (t !== s.tucked) { s.tucked = t; s.tuckAt = performance.now(); }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  });
}

export async function settled(page, { quiet = 150, timeout = 10000 } = {}) {
  // the quiet time starts with this call: what was seen in an earlier one does not count, or a change not yet applied (a wheel
  // scroll still on its way) would find the page already quiet
  await page.evaluate(() => { if (window.__settle) window.__settle.look = undefined; });
  await page.waitForFunction((quiet) => {
    const s = window.__settle; if (!s) throw new Error('trackSettle(ctx) was not called for this page');
    const now = performance.now();
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height), e.scrollTop, e.style.maxHeight]; };
    const look = JSON.stringify([innerWidth, innerHeight, s.tucked, box('#view'), box('.headrow'), box('.md .list'), box('.qpanel')]);
    if (look !== s.look) { s.look = look; s.since = now; }
    // only what plays out over time and ends: not a spinner or the dots of a pending draft, which run until their work is done,
    // nor the fade at the list's top edge, which follows its scroll position (a scroll timeline)
    const moving = document.getAnimations().some((a) => a.playState === 'running' && a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity);
    const fitted = !s.tuckAt || s.fitAt > s.tuckAt || !document.querySelector('.home.qapage');   // left the page before it was sized
    return !moving && fitted && now - s.tuckAt > 400 && now - s.since >= quiet;
  }, quiet, { polling: 'raf', timeout }).catch(async (e) => {
    // what was still moving, so a timeout says why
    const left = await page.evaluate(() => JSON.stringify({ settle: window.__settle, now: performance.now(), running: document.getAnimations().filter((a) => a.playState === 'running').map((a) => `${a.animationName ?? a.transitionProperty} on .${a.effect?.target?.className}`) })).catch(() => '');
    throw new Error(`The page did not settle: ${left}\n${e.message}`);
  });
}
