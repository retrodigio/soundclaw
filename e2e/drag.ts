// A drag that cannot be fooled by layout shift. An editor's numbers and badges arrive after a change
// and move what is under them; a drag started before that lands on the wrong element or is cut
// short. So a drag waits for the page to settle (an element's `data-measured`, if given), for the
// target to stop moving and to be the element under the pointer, moves in explicit steps, and lets
// go only once the control's value (or its draft) has followed the pointer.

import { expect, type Locator, type Page } from '@playwright/test';

export interface DragOptions {
  /** Where on the target to press, from its box (default: the centre). */
  at?: (b: { x: number; y: number; width: number; height: number }) => { x: number; y: number };
  /** Hold Shift through the drag (fine steps). */
  shift?: boolean;
  steps?: number;
  /** An element whose `data-measured` must be "true" first (an editor that measures after each change). */
  settled?: Locator;
  /** Wait for the value to change before letting go (default true; false for a drag that may leave it as it was). */
  expectChange?: boolean;
  /** The attribute that follows the drag (default aria-valuenow; a control with a draft may name its own). */
  attr?: string;
}

export async function settledDrag(page: Page, target: Locator, dx: number, dy: number, o: DragOptions = {}): Promise<void> {
  if (o.settled) await expect(o.settled).toHaveAttribute('data-measured', 'true');
  await target.scrollIntoViewIfNeeded();
  let x = 0, y = 0;
  let last = '';
  // the target has stopped moving and is what the pointer would press
  await expect.poll(async () => {
    const b = await target.boundingBox();
    if (!b) return false;
    const p = o.at ? o.at(b) : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const here = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const still = here === last;
    last = here;
    x = p.x;
    y = p.y;
    if (!still) return false;
    return target.evaluate((el, [px, py]) => { const hit = document.elementFromPoint(px as number, py as number); return !!hit && (el === hit || el.contains(hit)); }, [x, y]);
  }, { intervals: [50, 50, 100, 100, 200] }).toBe(true);
  const attr = o.attr ?? 'aria-valuenow';
  const before = await target.getAttribute(attr);
  await page.mouse.move(x, y);
  if (o.shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  const n = o.steps ?? 16;
  for (let i = 1; i <= n; i++) await page.mouse.move(x + (dx * i) / n, y + (dy * i) / n);
  if (o.expectChange !== false && before !== null) await expect(target).not.toHaveAttribute(attr, before);
  await page.mouse.up();
  if (o.shift) await page.keyboard.up('Shift');
}
