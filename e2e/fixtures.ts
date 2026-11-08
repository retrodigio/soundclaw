// The browser tests' `test`: a page whose browser keeps the choices a person made earlier, so the
// specs that read the whole sound list or the history tape find them where they always did:
// "Show all" on the home page, and the History tab open in the bottom panel.

import { test as base } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        if (!localStorage.getItem('soundclaw.prefs')) localStorage.setItem('soundclaw.prefs', JSON.stringify({ panels: { bottomTab: 'history' } }));
        if (localStorage.getItem('soundclaw.homeAll') === null) localStorage.setItem('soundclaw.homeAll', '1');
      } catch { /* storage off */ }
    });
    await use(page);
  },
});
