/**
 * Test: Screensaver idle delay per device (#885)
 * Purpose: The delay before the photo screensaver starts is a device-local
 *          choice like wall mode. Tested here: the module only ever applies one
 *          of its steps, the default is stored as "no key", theme-init.js sets
 *          the attribute before any module loads (and only for a valid step),
 *          and the component reads the attribute on every arming and re-arms
 *          when it changes - so a new value applies without a reload.
 * Run: node --test test/test-screensaver-idle.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const idle = await import('../public/utils/screensaver-idle.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function makeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function makeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (k, v) => { attrs.set(k, String(v)); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => { attrs.delete(k); },
    hasAttribute: (k) => attrs.has(k),
  };
}

function withBrowser(storage, fn) {
  const prev = { document: globalThis.document, localStorage: globalThis.localStorage };
  const root = makeRoot();
  globalThis.document = { documentElement: root, querySelectorAll: () => [] };
  globalThis.localStorage = storage;
  try {
    return fn(root);
  } finally {
    globalThis.document = prev.document;
    globalThis.localStorage = prev.localStorage;
  }
}

test('the steps are the ones agreed in #885, with five minutes as the default', () => {
  assert.deepEqual(idle.SCREENSAVER_IDLE_STEPS, [60, 120, 300, 600, 900]);
  assert.equal(idle.SCREENSAVER_IDLE_DEFAULT, 300);
  assert.ok(idle.SCREENSAVER_IDLE_STEPS.includes(idle.SCREENSAVER_IDLE_DEFAULT));
  // The component keeps a 30 s floor; no step may sit below it.
  assert.ok(Math.min(...idle.SCREENSAVER_IDLE_STEPS) >= 30);
});

test('only a step is applied - anything else falls back to the default', () => {
  for (const step of idle.SCREENSAVER_IDLE_STEPS) {
    assert.equal(idle.normalizeScreensaverIdle(step), step);
    assert.equal(idle.normalizeScreensaverIdle(String(step)), step, 'stored values are strings');
  }
  for (const junk of [null, undefined, '', 'abc', '45', 0, -60, 30, 59, 61, 3600, '60s', NaN]) {
    assert.equal(idle.normalizeScreensaverIdle(junk), 300, `${String(junk)} -> default`);
  }
});

test('the choice is stored on this device and applied to the running page', () => {
  const storage = makeStorage();
  withBrowser(storage, (root) => {
    assert.equal(idle.getScreensaverIdleSeconds(), 300, 'nothing stored -> default');

    assert.equal(idle.setScreensaverIdleSeconds(60), 60);
    assert.equal(storage.getItem(idle.SCREENSAVER_IDLE_KEY), '60');
    assert.equal(root.getAttribute('data-screensaver-idle'), '60');
    assert.equal(idle.getScreensaverIdleSeconds(), 60);

    // Back to the default removes the key: a device that went back to five
    // minutes looks like one that never touched the setting.
    assert.equal(idle.setScreensaverIdleSeconds(300), 300);
    assert.equal(storage.map.has(idle.SCREENSAVER_IDLE_KEY), false);
    assert.equal(root.getAttribute('data-screensaver-idle'), '300');

    // An invalid choice never lands in storage.
    assert.equal(idle.setScreensaverIdleSeconds(42), 300);
    assert.equal(storage.map.has(idle.SCREENSAVER_IDLE_KEY), false);
  });
});

test('a blocked storage neither throws nor stops the value from applying', () => {
  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  withBrowser(blocked, (root) => {
    assert.equal(idle.getScreensaverIdleSeconds(), 300);
    assert.equal(idle.setScreensaverIdleSeconds(120), 120);
    assert.equal(root.getAttribute('data-screensaver-idle'), '120', 'applies for this session');
  });
});

/** Runs the real theme-init.js against a stub root, as the page head would. */
function runThemeInit(storage) {
  const root = makeRoot();
  const doc = { documentElement: root, querySelectorAll: () => [] };
  new Function('localStorage', 'sessionStorage', 'document', 'location', read('../public/theme-init.js'))(
    storage, makeStorage(), doc, { pathname: '/settings' },
  );
  return root;
}

test('theme-init.js sets the delay before any module loads - and only a valid step', () => {
  for (const step of idle.SCREENSAVER_IDLE_STEPS) {
    const root = runThemeInit(makeStorage({ [idle.SCREENSAVER_IDLE_KEY]: String(step) }));
    assert.equal(root.getAttribute('data-screensaver-idle'), String(step));
  }
  for (const junk of [null, '', 'abc', '45', '0', '3600']) {
    const root = runThemeInit(makeStorage(junk === null ? {} : { [idle.SCREENSAVER_IDLE_KEY]: junk }));
    assert.equal(root.hasAttribute('data-screensaver-idle'), false,
      `${String(junk)} leaves the attribute off, the component keeps its default`);
  }
});

test('the component reads the delay on every arming and re-arms when it changes', () => {
  const source = read('../public/components/photo-screensaver.js');

  // Read once at module load (the state before #885) would freeze the value
  // theme-init.js happened to set and ignore every later change.
  assert.ok(!/const IDLE_MS\s*=/.test(source), 'no delay frozen at load');
  assert.match(source, /function idleMs\(\)\s*\{[^}]*dataset\.screensaverIdle/,
    'the delay is read from the attribute when the timer is armed');
  assert.match(source, /Math\.max\(30,/, 'the 30 second floor stays');
  const armings = source.match(/idleTimer\s*=\s*setTimeout\(\s*start,\s*([^)]+\))/g) || [];
  assert.ok(armings.length >= 3, `every arming found (${armings.length})`);
  for (const arming of armings) assert.match(arming, /idleMs\(\)/, `${arming} uses the current delay`);

  // A changed attribute re-arms the timer at once.
  const observer = source.slice(source.indexOf('new MutationObserver'));
  assert.match(observer, /attributeFilter:\s*\[\s*'data-screensaver-idle'\s*\]/,
    'the component watches exactly the attribute the setting writes');
  assert.match(observer, /idleTimer\s*=\s*setTimeout\(\s*start,\s*idleMs\(\)\s*\)/);
});

test('the setting sits next to wall mode in Appearance, not under the Immich connection', () => {
  const appearance = read('../public/settings/pages/personal-appearance.js');
  assert.match(appearance, /from '\/utils\/screensaver-idle\.js'/);
  assert.match(appearance, /id="screensaver-idle-select"/);
  assert.ok(appearance.indexOf('wall-mode-toggle') < appearance.indexOf('screensaver-idle-select'),
    'rendered right after the wall mode card');
  // The household part (server, key, album) is untouched by this setting.
  assert.ok(!/screensaver-idle/.test(read('../public/settings/pages/admin-immich.js')));
});
