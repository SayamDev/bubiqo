/**
 * A minimal, honest fake of the chrome.* surface the service worker uses.
 *
 * This exists so the worker's message routing, its chrome-backed ports and the
 * alarm scheduling can be exercised in Node. It implements the real semantics that
 * matter — storage round-trips through structured values, alarms refuse to be
 * scheduled in the past, executeScript returns an array of injection results — and
 * nothing else.
 */

export interface FakeChrome {
  storage: {
    local: {
      get(key?: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    session: { get(key?: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };
  };
  alarms: { create(name: string, info: { when: number }): Promise<void>; clear(name: string): Promise<boolean>; clearAll(): Promise<boolean>; onAlarm: Listener };
  runtime: { onMessage: MessageListener; onInstalled: Listener; onStartup: Listener };
  tabs: {
    query(q: unknown): Promise<{ id?: number; url?: string; active?: boolean }[]>;
    onUpdated: Listener;
    onActivated: Listener;
  };
  scripting: { executeScript(opts: unknown): Promise<{ result: unknown }[]> };
  action: { setBadgeText(o: { text: string }): Promise<void>; setBadgeBackgroundColor(o: unknown): Promise<void> };
  permissions: { contains(o: { origins: string[] }): Promise<boolean>; request(o: { origins: string[] }): Promise<boolean> };
  sidePanel: { setPanelBehavior(o: unknown): Promise<void>; open(o: { tabId: number }): Promise<void> };
  contextMenus: {
    removeAll(cb?: () => void): void;
    create(o: unknown): void;
    onClicked: { addListener(fn: (info: unknown, tab?: unknown) => void): void; dispatch(info: unknown, tab?: unknown): void };
  };
}

interface Listener { addListener(fn: (...args: never[]) => unknown): void }
interface MessageListener extends Listener { dispatch(request: unknown): Promise<unknown> }

export interface FakeState {
  store: Record<string, unknown>;
  /** chrome.storage.session — survives a worker restart, cleared on browser close. */
  session: Record<string, unknown>;
  alarms: Map<string, number>;
  badge: string;
  activeTab: { id?: number; url?: string };
  pageResult: unknown;
  /** Simulates Chrome refusing injection for want of a page permission. */
  denyInjection?: boolean;
  /** Simulates the user declining the permission prompt. */
  denyPermission?: boolean;
  /** How many times the extractor has been injected, so a test can see a re-read. */
  injections: number;
  /** Context menu items registered by the worker. */
  menus: unknown[];
  /** Whether the side panel was opened. */
  panelOpened?: boolean;
  grantedOrigins: string[];
}

export function installFakeChrome(state: FakeState): FakeChrome {
  let messageHandler: ((req: unknown, sender: unknown, respond: (r: unknown) => void) => boolean) | undefined;
  let menuHandler: ((info: unknown, tab?: unknown) => void) | undefined;
  const installedHandlers: (() => void)[] = [];

  const chrome: FakeChrome = {
    storage: {
      local: {
        async get(key?: string) {
          if (key === undefined) return { ...state.store };
          return key in state.store ? { [key]: state.store[key] } : {};
        },
        async set(items) {
          Object.assign(state.store, items);
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state.store[key];
        },
      },
      session: {
        async get(key?: string) {
          if (key === undefined) return { ...state.session };
          return key in state.session ? { [key]: state.session[key] } : {};
        },
        async set(items: Record<string, unknown>) { Object.assign(state.session, items); },
        async remove(key: string) { delete state.session[key]; },
      },
    },
    alarms: {
      async create(name, info) {
        // Chrome will not schedule an alarm in the past; neither do we.
        if (info.when > Date.now()) state.alarms.set(name, info.when);
      },
      async clear(name) {
        return state.alarms.delete(name);
      },
      async clearAll() {
        state.alarms.clear();
        return true;
      },
      onAlarm: { addListener() {} },
    },
    runtime: {
      onMessage: {
        addListener(fn) {
          messageHandler = fn as never;
        },
        async dispatch(request) {
          return new Promise((resolve) => {
            messageHandler?.(request, {}, resolve);
          });
        },
      },
      onInstalled: {
        // Chrome fires this once, on install. Firing it as the listener registers
        // matches that: firing earlier means the worker has not subscribed yet.
        addListener(fn) {
          installedHandlers.push(fn as () => void);
          queueMicrotask(() => (fn as () => void)());
        },
      },
      onStartup: { addListener() {} },
    },
    tabs: {
      async query() {
        return [{ ...state.activeTab, active: true }];
      },
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
    },
    scripting: {
      async executeScript() {
        /*
         * Chrome throws when you try to inject into a privileged page, and refuses
         * without activeTab or a host permission. The fake has to do the same, or
         * tests will "pass" against behaviour the browser never allows.
         */
        const url = state.activeTab.url ?? "";
        if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
          throw new Error("Cannot access a chrome:// URL");
        }
        if (state.denyInjection) throw new Error("Cannot access contents of the page");

        // The injected script reports the page's own location, so keep them in step.
        state.injections += 1;
        const page = state.pageResult as Record<string, unknown>;
        const result = url
          ? { ...page, url, domain: new URL(url).hostname }
          : page;
        return [{ result }];
      },
    },
    action: {
      async setBadgeText(o) {
        state.badge = o.text;
      },
      async setBadgeBackgroundColor() {},
    },
    sidePanel: {
      async setPanelBehavior() {},
      async open() { state.panelOpened = true; },
    },
    contextMenus: {
      removeAll(cb) { state.menus.length = 0; cb?.(); },
      create(o) { state.menus.push(o); },
      onClicked: {
        addListener(fn) { menuHandler = fn; },
        dispatch(info, tab) { menuHandler?.(info, tab); },
      },
    },
    permissions: {
      async contains(o) {
        return o.origins.every((origin) => state.grantedOrigins.includes(origin));
      },
      async request(o) {
        // Chrome shows a prompt; the fake grants whatever the test said it would.
        if (state.denyPermission) return false;
        state.grantedOrigins.push(...o.origins);
        state.denyInjection = false;
        return true;
      },
    },
  };

  (globalThis as unknown as { chrome: FakeChrome }).chrome = chrome;
  (globalThis as unknown as { crypto: Crypto }).crypto ??= { randomUUID: () => `${Math.random()}`.slice(2) } as Crypto;
  return chrome;
}

export function freshState(page: unknown, url = "https://mail.example.com/f001"): FakeState {
  return { store: {}, session: {}, alarms: new Map(), badge: "", activeTab: { id: 1, url }, pageResult: page, grantedOrigins: [], menus: [], injections: 0 };
}
