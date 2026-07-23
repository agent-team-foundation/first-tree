import { describe, expect, it, vi } from "vitest";
import {
  CROSS_DOCUMENT_AUTH_CHANNEL_NAME,
  CROSS_DOCUMENT_AUTH_STORAGE_KEY,
  type CrossDocumentAuthNotice,
  type CrossDocumentBroadcastChannel,
  type CrossDocumentNoticeStorage,
  installCrossDocumentAuthNotices,
} from "../session/cross-document-notices.js";
import { LEGACY_LOCAL_STORAGE_KEYS, scrubLegacyWebStorage } from "../session/legacy-scrub.js";

class MemoryStorage implements CrossDocumentNoticeStorage {
  readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

class RefusedRemovalStorage extends MemoryStorage {
  public override removeItem(_key: string): void {
    throw new DOMException("Removal refused", "SecurityError");
  }
}

class ToggleDropStorage extends MemoryStorage {
  dropWrites = false;

  public override setItem(key: string, value: string): void {
    if (!this.dropWrites) super.setItem(key, value);
  }
}

class FakeBroadcastChannel implements CrossDocumentBroadcastChannel {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly sent: string[] = [];
  closed = false;

  public constructor(
    readonly name: string,
    private readonly peers: Set<FakeBroadcastChannel>,
  ) {
    peers.add(this);
  }

  public addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  public removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  public postMessage(message: string): void {
    this.sent.push(message);
    for (const peer of this.peers) {
      if (peer !== this && !peer.closed) peer.dispatch(message);
    }
  }

  public dispatch(data: unknown): void {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of [...this.listeners]) listener(event);
  }

  public dispatchHostileData(): void {
    const event = Object.create(null) as MessageEvent<unknown>;
    Object.defineProperty(event, "data", {
      get(): never {
        throw new Error("hostile getter");
      },
    });
    for (const listener of [...this.listeners]) listener(event);
  }

  public close(): void {
    this.closed = true;
    this.peers.delete(this);
  }
}

class BroadcastHub {
  readonly peers = new Set<FakeBroadcastChannel>();

  public create = (name: string): FakeBroadcastChannel => new FakeBroadcastChannel(name, this.peers);
}

function storageEvent(
  key: string | null,
  newValue: string | null,
  storageArea: CrossDocumentNoticeStorage | null,
): Event {
  const event = new Event("storage");
  Object.defineProperties(event, {
    key: { value: key },
    newValue: { value: newValue },
    storageArea: { value: storageArea },
  });
  return event;
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

describe("cross-document auth notices", () => {
  it("synchronously sends one canonical source-retired hint over both advisory paths", () => {
    const hub = new BroadcastHub();
    const storage = new MemoryStorage();
    const receiverWindow = new EventTarget();
    const received: CrossDocumentAuthNotice[] = [];
    const receiver = installCrossDocumentAuthNotices({
      localStorage: storage,
      windowTarget: receiverWindow,
      createBroadcastChannel: hub.create,
      createId: sequence("receiver"),
      onNotice: (notice) => received.push(notice),
    });
    const sender = installCrossDocumentAuthNotices({
      localStorage: storage,
      windowTarget: new EventTarget(),
      createBroadcastChannel: hub.create,
      createId: () => "event-1",
      onNotice: vi.fn(),
    });

    let returned = false;
    const observeReturnOrder = vi.fn(() => {
      expect(returned).toBe(false);
    });
    receiver.dispose();
    const orderedReceiver = installCrossDocumentAuthNotices({
      localStorage: storage,
      windowTarget: receiverWindow,
      createBroadcastChannel: hub.create,
      createId: sequence("ordered"),
      onNotice: (notice) => {
        received.push(notice);
        observeReturnOrder();
      },
    });

    const delivery = sender.publishSourceRetired("epoch-E");
    returned = true;

    expect(sender.available).toBe(true);
    expect(delivery).toEqual({ broadcast: true, storage: true });
    expect(observeReturnOrder).toHaveBeenCalledOnce();
    expect(received).toEqual([{ v: 1, kind: "source-retired", eventId: "event-1", sessionEpoch: "epoch-E" }]);
    const raw = [...hub.peers].find((channel) => channel.sent.length > 0)?.sent[0];
    expect(raw).toBe('{"v":1,"kind":"source-retired","eventId":"event-1","sessionEpoch":"epoch-E"}');
    expect(raw).not.toMatch(/account|server|organization|token|fingerprint|scope/iu);
    expect(storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).toBeNull();

    receiverWindow.dispatchEvent(storageEvent(CROSS_DOCUMENT_AUTH_STORAGE_KEY, raw ?? null, storage));
    expect(received).toHaveLength(1);

    orderedReceiver.dispose();
    sender.dispose();
  });

  it("publishes an authority-advanced hint without source identity", () => {
    const hub = new BroadcastHub();
    const storage = new MemoryStorage();
    const received = vi.fn();
    const receiver = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: hub.create,
      createId: sequence("receiver"),
      onNotice: received,
    });
    const sender = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: hub.create,
      createId: () => "advanced-1",
      onNotice: vi.fn(),
    });

    expect(sender.publishAuthorityAdvanced()).toEqual({ broadcast: true, storage: true });
    expect(received).toHaveBeenCalledWith({ v: 1, kind: "authority-advanced", eventId: "advanced-1" });

    receiver.dispose();
    sender.dispose();
  });

  it("rejects noncanonical, malformed, oversized, object, and hostile message data", () => {
    const hub = new BroadcastHub();
    const storage = new MemoryStorage();
    const received = vi.fn();
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: hub.create,
      createId: sequence("event"),
      onNotice: received,
    });
    const channel = [...hub.peers][0];
    if (!channel) throw new Error("Expected a broadcast channel");

    const invalid: unknown[] = [
      { v: 1, kind: "authority-advanced", eventId: "object" },
      "not-json",
      '{ "v":1,"kind":"authority-advanced","eventId":"spaces"}',
      '{"v":1,"kind":"authority-advanced","eventId":"extra","extra":true}',
      '{"v":1,"kind":"authority-advanced","eventId":"first","eventId":"duplicate"}',
      '{"v":2,"kind":"authority-advanced","eventId":"version"}',
      '{"v":1,"kind":"unknown","eventId":"kind"}',
      `{"v":1,"kind":"authority-advanced","eventId":"${"x".repeat(5_000)}"}`,
    ];
    for (const value of invalid) channel.dispatch(value);
    channel.dispatchHostileData();

    expect(received).not.toHaveBeenCalled();
    transport.dispose();
  });

  it("keeps duplicate suppression bounded", () => {
    const hub = new BroadcastHub();
    const storage = new MemoryStorage();
    const received = vi.fn();
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: hub.create,
      createId: sequence("event"),
      onNotice: received,
    });
    const channel = [...hub.peers][0];
    if (!channel) throw new Error("Expected a broadcast channel");
    const notice = (eventId: string): string => JSON.stringify({ v: 1, kind: "authority-advanced", eventId });

    channel.dispatch(notice("event-0"));
    channel.dispatch(notice("event-0"));
    for (let index = 1; index <= 256; index += 1) channel.dispatch(notice(`event-${index}`));
    channel.dispatch(notice("event-0"));

    expect(received).toHaveBeenCalledTimes(258);
    transport.dispose();
  });

  it("does not report a second delivery when its id source repeats a live event id", () => {
    const hub = new BroadcastHub();
    const storage = new MemoryStorage();
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: hub.create,
      createId: () => "repeated-event",
      onNotice: vi.fn(),
    });

    expect(transport.publishAuthorityAdvanced()).toEqual({ broadcast: true, storage: true });
    expect(transport.publishSourceRetired("epoch-E")).toEqual({ broadcast: false, storage: false });
    expect([...hub.peers][0]?.sent).toHaveLength(1);
    expect(storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).toBeNull();
    transport.dispose();
  });

  it("uses storage independently and reports unverified pulse removal", () => {
    const storage = new MemoryStorage();
    const storageOnly = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: () => null,
      createId: () => "storage-only",
      onNotice: vi.fn(),
    });
    expect(storageOnly.available).toBe(true);
    expect(storageOnly.publishAuthorityAdvanced()).toEqual({ broadcast: false, storage: true });
    expect(storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).toBeNull();
    storageOnly.dispose();

    const refused = new RefusedRemovalStorage();
    const failedRemoval = installCrossDocumentAuthNotices({
      localStorage: refused,
      createBroadcastChannel: () => null,
      createId: () => "refused-removal",
      onNotice: vi.fn(),
    });
    expect(failedRemoval.available).toBe(false);
    expect(failedRemoval.publishSourceRetired("epoch-E")).toEqual({ broadcast: false, storage: false });
    expect(refused.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).not.toBeNull();
    failedRemoval.dispose();
  });

  it("does not report a storage pulse when writes begin silently dropping after preflight", () => {
    const storage = new ToggleDropStorage();
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: () => null,
      createId: () => "silently-dropped",
      onNotice: vi.fn(),
    });
    expect(transport.available).toBe(true);

    storage.dropWrites = true;
    expect(transport.publishSourceRetired("epoch-E")).toEqual({ broadcast: false, storage: false });
    expect(storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).toBeNull();
    transport.dispose();
  });

  it("does not mistake an identical stale value for a newly delivered storage pulse", () => {
    const storage = new ToggleDropStorage();
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel: () => null,
      createId: () => "stale-identical",
      onNotice: vi.fn(),
    });
    storage.setItem(
      CROSS_DOCUMENT_AUTH_STORAGE_KEY,
      '{"v":1,"kind":"source-retired","eventId":"stale-identical","sessionEpoch":"epoch-E"}',
    );
    storage.dropWrites = true;

    expect(transport.publishSourceRetired("epoch-E")).toEqual({ broadcast: false, storage: false });
    expect(storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).toBeNull();
    transport.dispose();
  });

  it("keeps broadcast delivery independent from storage exceptions", () => {
    const hub = new BroadcastHub();
    const receiverStorage = new MemoryStorage();
    const received = vi.fn();
    const receiver = installCrossDocumentAuthNotices({
      localStorage: receiverStorage,
      createBroadcastChannel: hub.create,
      createId: sequence("receiver"),
      onNotice: received,
    });
    const sender = installCrossDocumentAuthNotices({
      localStorage: new RefusedRemovalStorage(),
      createBroadcastChannel: hub.create,
      createId: () => "broadcast-only",
      onNotice: vi.fn(),
    });

    expect(sender.available).toBe(true);
    expect(sender.publishSourceRetired("epoch-E")).toEqual({ broadcast: true, storage: false });
    expect(received).toHaveBeenCalledOnce();

    receiver.dispose();
    sender.dispose();
  });

  it("accepts only the exact localStorage pulse and stops after dispose", () => {
    const storage = new MemoryStorage();
    const otherStorage = new MemoryStorage();
    const windowTarget = new EventTarget();
    const received = vi.fn();
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      windowTarget,
      createBroadcastChannel: () => null,
      createId: sequence("event"),
      onNotice: received,
    });
    const raw = '{"v":1,"kind":"source-retired","eventId":"event-1","sessionEpoch":"epoch-E"}';

    windowTarget.dispatchEvent(storageEvent("another-key", raw, storage));
    windowTarget.dispatchEvent(storageEvent(CROSS_DOCUMENT_AUTH_STORAGE_KEY, raw, otherStorage));
    windowTarget.dispatchEvent(storageEvent(CROSS_DOCUMENT_AUTH_STORAGE_KEY, null, storage));
    expect(received).not.toHaveBeenCalled();

    windowTarget.dispatchEvent(storageEvent(CROSS_DOCUMENT_AUTH_STORAGE_KEY, raw, storage));
    expect(received).toHaveBeenCalledOnce();
    transport.dispose();
    windowTarget.dispatchEvent(
      storageEvent(CROSS_DOCUMENT_AUTH_STORAGE_KEY, '{"v":1,"kind":"authority-advanced","eventId":"event-2"}', storage),
    );
    expect(received).toHaveBeenCalledOnce();
    expect(transport.publishAuthorityAdvanced()).toEqual({ broadcast: false, storage: false });
  });

  it("snapshots caller-owned options and isolates a throwing notice handler", () => {
    const hub = new BroadcastHub();
    const storage = new MemoryStorage();
    const original = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("projection failed");
      })
      .mockImplementation(() => undefined);
    const replacement = vi.fn();
    const reads = { storage: 0, notice: 0, channel: 0, id: 0, target: 0 };
    const values = {
      storage,
      notice: original,
      channel: hub.create,
      id: sequence("event"),
      target: new EventTarget(),
    };
    const options = {
      get localStorage(): MemoryStorage {
        reads.storage += 1;
        return values.storage;
      },
      get onNotice(): (notice: CrossDocumentAuthNotice) => void {
        reads.notice += 1;
        return values.notice;
      },
      get createBroadcastChannel(): BroadcastHub["create"] {
        reads.channel += 1;
        return values.channel;
      },
      get createId(): () => string {
        reads.id += 1;
        return values.id;
      },
      get windowTarget(): EventTarget {
        reads.target += 1;
        return values.target;
      },
    };
    const transport = installCrossDocumentAuthNotices(options);
    values.notice = replacement;
    const channel = [...hub.peers][0];
    if (!channel) throw new Error("Expected a broadcast channel");

    expect(() => channel.dispatch('{"v":1,"kind":"authority-advanced","eventId":"incoming-1"}')).not.toThrow();
    channel.dispatch('{"v":1,"kind":"authority-advanced","eventId":"incoming-2"}');

    expect(original).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(reads).toEqual({ storage: 1, notice: 1, channel: 1, id: 1, target: 1 });
    transport.dispose();
  });

  it("uses the fixed channel name and scrubs a crash-residue pulse", () => {
    const storage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const createBroadcastChannel = vi.fn(() => null);
    const transport = installCrossDocumentAuthNotices({
      localStorage: storage,
      createBroadcastChannel,
      createId: sequence("event"),
      onNotice: vi.fn(),
    });
    storage.setItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY, "stale-advisory-only-pulse");
    storage.setItem("safe-preference", "keep");

    expect(createBroadcastChannel).toHaveBeenCalledWith(CROSS_DOCUMENT_AUTH_CHANNEL_NAME);
    expect(LEGACY_LOCAL_STORAGE_KEYS).toContain(CROSS_DOCUMENT_AUTH_STORAGE_KEY);
    expect(scrubLegacyWebStorage({ localStorage: storage, sessionStorage })).toEqual({
      localStorageKeysRemoved: 1,
      sessionStorageKeysRemoved: 0,
    });
    expect(storage.getItem(CROSS_DOCUMENT_AUTH_STORAGE_KEY)).toBeNull();
    expect(storage.getItem("safe-preference")).toBe("keep");
    transport.dispose();
  });
});
