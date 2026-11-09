// The contrast check the accessibility specs run in the page: every element that shows text (its own
// text nodes, or an input's value) is measured against what is behind it, from the computed colours.
// The background is found by walking up the ancestors and laying their background colours over one
// another; opacity on the way multiplies into the text. Text needs 4.5:1; large text (24 px, or
// 18.66 px bold) and UI glyphs (a check glyph, an arrow: one or two symbols, no letters) need 3:1.
// Skipped, and counted: disabled controls, decorative text (inside aria-hidden), text over an image
// or a gradient (no single background colour), and text that is not on screen or is covered (a dialog's scrim).

export interface ContrastFail { where: string; text: string; ratio: number; need: number; fg: string; bg: string; size: number }
export interface ContrastResult { checked: number; fails: ContrastFail[]; skipped: { disabled: number; decorative: number; overImage: number; covered: number } }

/** Runs in the page (passed to page.evaluate): no closures over test code. */
export function measureContrast(): ContrastResult {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  const cache = new Map<string, [number, number, number, number]>();
  // any CSS colour (rgb(), color(srgb …), color-mix results) as 8-bit RGBA, through the canvas
  const rgba = (c: string): [number, number, number, number] => {
    let v = cache.get(c);
    if (v) return v;
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    cache.set(c, v);
    return v;
  };
  const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] =>
    [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number];
  const lum = (c: [number, number, number]) => {
    const f = (x: number) => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c: [number, number, number]) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  const describe = (el: Element) => {
    const t = el.closest('[data-testid]')?.getAttribute('data-testid');
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` in [${t}]` : ''}`;
  };
  const ground = rgba(getComputedStyle(document.documentElement).backgroundColor);
  const base: [number, number, number] = ground[3] > 0 ? [ground[0], ground[1], ground[2]] : [255, 255, 255];

  /** The colour behind `el`, or null when an ancestor paints an image or a gradient. */
  const behind = (el: Element): [number, number, number] | null => {
    const layers: [number, number, number, number][] = [];
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      // a box smaller than the text that the text's middle is outside of (a label hung off a 2 px line) is not behind it
      if (e !== el) { const b = e.getBoundingClientRect(); if ((b.width < r.width || b.height < r.height) && (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom)) continue; }
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let col = base;
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i]!, col);
    return col;
  };
  const opacityOf = (el: Element) => { let o = 1; for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };

  const res: ContrastResult = { checked: 0, fails: [], skipped: { disabled: 0, decorative: 0, overImage: 0, covered: 0 } };
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.body.querySelectorAll('*')) {
    if (el instanceof HTMLScriptElement || el instanceof HTMLStyleElement || el.closest('svg') && !(el instanceof SVGTextElement)) continue;
    let text = '';
    if (el instanceof HTMLInputElement) { if (['checkbox', 'radio', 'range', 'hidden', 'color'].includes(el.type)) continue; text = el.value; }
    else if (el instanceof HTMLSelectElement) text = el.selectedOptions[0]?.textContent ?? '';
    else if (el instanceof HTMLTextAreaElement) text = el.value.slice(0, 40);
    else for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent ?? '';
    text = text.trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const s = getComputedStyle(el);
    if (s.visibility !== 'visible' || Number(s.opacity) === 0) continue;
    if (el.closest('[aria-hidden="true"]')) { res.skipped.decorative++; continue; }
    // under a dialog's scrim, or scrolled out of its box: what is on top there is checked instead
    const hx = Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width / 2, 8))), hy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(hx, hy);
    const clear = hit && (hit instanceof HTMLTextAreaElement || hit instanceof HTMLInputElement) && rgba(getComputedStyle(hit).color)[3] === 0;
    if (hit && !clear && hit !== el && !el.contains(hit) && !hit.contains(el)) { res.skipped.covered++; continue; }
    if (el.closest(':disabled, [aria-disabled="true"], [data-disabled]')) { res.skipped.disabled++; continue; }
    const bg = behind(el);
    if (!bg) { res.skipped.overImage++; continue; }
    const fgc = rgba(el instanceof SVGTextElement ? s.fill : s.color);
    // transparent text is drawn by a layer under it (the pattern text's editing surface): that layer is what is checked
    if (fgc[3] === 0) { res.skipped.decorative++; continue; }
    // inside something faded out (a control that shows on hover): not on screen
    if (opacityOf(el) < 0.05) continue;
    const fg = over([fgc[0], fgc[1], fgc[2], fgc[3] * opacityOf(el)], bg);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const glyph = text.length <= 2 && !/[\p{L}\p{N}]/u.test(text);
    const need = size >= 24 || (size >= 18.66 && bold) || glyph ? 3 : 4.5;
    const q = ratio(fg, bg);
    res.checked++;
    if (q < need - 0.005) res.fails.push({ where: describe(el), text: text.slice(0, 40), ratio: Math.round(q * 100) / 100, need, fg: hex(fg), bg: hex(bg), size });
  }
  return res;
}
