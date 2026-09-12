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
  storage: { local: { get(key?: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }; session?: unknown };
  alarms: { create(name: string, info: { when: number }): Promise<void>; clear(name: string): Promise<boolean>; onAlarm: Listener };
  runtime: { onMessage: MessageListener; onInstalled: Listener; onStartup: Listener };
  tabs: { query(q: unknown): Promise<{ id?: number; url?: string; active?: boolean }[]> };
  scripting: { executeScript(opts: unknown): Promise<{ result: unknown }[]> };
  action: { setBadgeText(o: { text: string }): Promise<void>; setBadgeBackgroundColor(o: unknown): Promise<void> };
  permissions: { contains(o: { origins: string[] }): Promise<boolean> };
  sidePanel: { setPanelBehavior(o: unknown): Promise<void> };
}

interface Listener { addListener(fn: (...args: never[]) => unknown): void }
interface MessageListener extends Listener { dispatch(request: unknown): Promise<unknown> }

export interface FakeState {
  store: Record<string, unknown>;
  alarms: Map<string, number>;
  badge: string;
  activeTab: { id?: number; url?: string };
  pageResult: unknown;
  /** Simulates Chrome refusing injection for want of activeTab. */
  denyInjection?: boolean;
  grantedOrigins: string[];
}

export function installFakeChrome(state: FakeState): FakeChrome {
  let messageHandler: ((req: unknown, sender: unknown, respond: (r: unknown) => void) => boolean) | undefined;

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
      },
      session: { set: async () => undefined },
    },
    alarms: {
      async create(name, info) {
        // Chrome will not schedule an alarm in the past; neither do we.
        if (info.when > Date.now()) state.alarms.set(name, info.when);
      },
      async clear(name) {
        return state.alarms.delete(name);
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
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    tabs: {
      async query() {
        return [{ ...state.activeTab, active: true }];
      },
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
    sidePanel: { async setPanelBehavior() {} },
    permissions: {
      async contains(o) {
        return o.origins.some((origin) => state.grantedOrigins.includes(origin));
      },
    },
  };

  (globalThis as unknown as { chrome: FakeChrome }).chrome = chrome;
  (globalThis as unknown as { crypto: Crypto }).crypto ??= { randomUUID: () => `${Math.random()}`.slice(2) } as Crypto;
  return chrome;
}

export function freshState(page: unknown, url = "https://mail.example.com/f001"): FakeState {
  return { store: {}, alarms: new Map(), badge: "", activeTab: { id: 1, url }, pageResult: page, grantedOrigins: [] };
}
