import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { installAccountStoreRuntime } from "../../auth/session/account-store-runtime.js";
import { closeCoordinatorConnections } from "../../auth/session/coordinator.js";
import { createAccountScopeKey, createScopedDatabaseName } from "../../auth/session/scope.js";
import {
  type ActivationCertificate,
  createAccountLease,
  createActivationCertificate,
  createViewLease,
  type JsonValue,
  type ViewLease,
} from "../../auth/session/types.js";
import { ACCOUNT_STATE_DATABASE_SPEC, type AccountStateEntry, AccountStateStore } from "../account-state-store.js";
import {
  createStoreFixture,
  databaseNames,
  replaceOrganization,
  replaceStoreFixture,
  type StoreFixture,
} from "./scoped-store-fixture.js";

const SERVER_A = "https://one.example.test/api/v1";
const SERVER_B = "https://two.example.test/api/v1";

let currentFixture: StoreFixture | null = null;
const store = new AccountStateStore();

function activation(label: string, serverAuthority = SERVER_A, accountId = `account-${label}`): ActivationCertificate {
  return createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: `generation-${label}`,
    transitionPermitId: `permit-${label}`,
    serverAuthority,
    accountId,
    scopeKey: createAccountScopeKey(serverAuthority, accountId),
  });
}

function forOwnerTab(lease: ViewLease, ownerTabId: string): ViewLease {
  return createViewLease({
    activation: lease.activation,
    organizationId: lease.organizationId,
    orgRevision: lease.orgRevision,
    ownerTabId,
    documentId: `${lease.documentId}-${ownerTabId}`,
    signal: lease.signal,
  });
}

function physicalName(certificate: ActivationCertificate): string {
  return createScopedDatabaseName(
    ACCOUNT_STATE_DATABASE_SPEC.logicalName,
    ACCOUNT_STATE_DATABASE_SPEC.namespaceVersion,
    certificate.scopeKey,
  );
}

async function openAccountStateDatabase(factory: IDBFactory, certificate: ActivationCertificate): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(physicalName(certificate), ACCOUNT_STATE_DATABASE_SPEC.databaseVersion);
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (!transaction) throw new Error("Account-state seed upgrade has no transaction");
      ACCOUNT_STATE_DATABASE_SPEC.upgrade(request.result, event.oldVersion, event.newVersion, transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to seed account-state database"));
    request.onblocked = () => reject(new Error("Account-state seed open was blocked"));
  });
}

async function seedDormantEntry(
  factory: IDBFactory,
  certificate: ActivationCertificate,
  organizationId: string,
  entry: AccountStateEntry,
): Promise<void> {
  const database = await openAccountStateDatabase(factory, certificate);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("entries", "readwrite");
      transaction.objectStore("entries").put({
        v: 1,
        sessionEpoch: certificate.sessionEpoch,
        partitionKind: "organization",
        partitionId: organizationId,
        kind: entry.kind,
        key: entry.key,
        tabId: entry.tabId ?? "",
        value: entry.value,
        updatedAt: entry.updatedAt,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Account-state seed transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Account-state seed transaction aborted"));
    });
  } finally {
    database.close();
  }
}

async function seedDormantAccountEntry(
  factory: IDBFactory,
  certificate: ActivationCertificate,
  ownerTabId: string,
  entry: AccountStateEntry,
): Promise<void> {
  const database = await openAccountStateDatabase(factory, certificate);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("entries", "readwrite");
      transaction.objectStore("entries").put({
        v: 1,
        sessionEpoch: certificate.sessionEpoch,
        partitionKind: "account",
        partitionId: "account",
        kind: entry.kind,
        key: entry.key,
        tabId: ownerTabId,
        value: entry.value,
        updatedAt: entry.updatedAt,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Account-state seed transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Account-state seed transaction aborted"));
    });
  } finally {
    database.close();
  }
}

async function seedRawEntry(factory: IDBFactory, certificate: ActivationCertificate, value: unknown): Promise<void> {
  const database = await openAccountStateDatabase(factory, certificate);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("entries", "readwrite");
      transaction.objectStore("entries").put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Account-state raw seed failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Account-state raw seed aborted"));
    });
  } finally {
    database.close();
  }
}

afterEach(() => {
  currentFixture?.dispose();
  currentFixture = null;
  closeCoordinatorConnections();
});

describe("AccountStateStore", () => {
  it("separates account-level navigation from organization rows", async () => {
    const orgA = await createStoreFixture({
      label: "account-partition-a",
      accountId: "account-a",
      organizationId: "org-a",
    });
    currentFixture = orgA;
    const accountStore = new AccountStateStore();
    const accountLease = orgA.accountLease;
    await accountStore.putAccountEntry(accountLease, {
      kind: "navigation",
      key: "selected-organization",
      tabId: accountLease.ownerTabId,
      value: { organizationId: "org-a" },
      updatedAt: 1,
    });
    await accountStore.putEntry(orgA.lease, {
      kind: "draft",
      key: "chat-a",
      value: { text: "org-a-only" },
      updatedAt: 1,
    });

    const orgB = replaceOrganization(orgA, {
      label: "account-partition-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await expect(
      accountStore.getAccountEntry(accountLease, {
        kind: "navigation",
        key: "selected-organization",
        tabId: accountLease.ownerTabId,
      }),
    ).resolves.toMatchObject({ value: { organizationId: "org-a" } });
    await expect(accountStore.getEntry(orgB.lease, { kind: "draft", key: "chat-a" })).resolves.toBeNull();

    const orgAReturn = replaceOrganization(orgB, {
      label: "account-partition-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    await expect(accountStore.getEntry(orgAReturn.lease, { kind: "draft", key: "chat-a" })).resolves.toMatchObject({
      value: { text: "org-a-only" },
    });
  });

  it("keeps account-level tab rows private to their opaque owner tab", async () => {
    const active = await createStoreFixture({ label: "account-tab-partition", organizationId: "org-a" });
    currentFixture = active;
    const accountStore = new AccountStateStore();
    const tabA = active.accountLease;
    const tabB = createAccountLease({
      activation: active.activation,
      accountRevision: "account-revision-tab-b",
      ownerTabId: "owner-tab-b",
      documentId: "document-b",
      signal: new AbortController().signal,
    });
    await accountStore.putAccountEntry(tabA, {
      kind: "navigation",
      key: "selected-organization",
      tabId: tabA.ownerTabId,
      value: { organizationId: "org-a" },
      updatedAt: 1,
    });
    const disposeTabB = installAccountStoreRuntime({ barrier: active.barrier, lease: tabB });
    try {
      await expect(
        accountStore.getAccountEntry(tabB, {
          kind: "navigation",
          key: "selected-organization",
          tabId: tabB.ownerTabId,
        }),
      ).resolves.toBeNull();
      await expect(
        accountStore.getAccountEntry(tabB, {
          kind: "navigation",
          key: "selected-organization",
          tabId: tabA.ownerTabId,
        }),
      ).rejects.toMatchObject({ code: "admission_denied" });
      await expect(
        accountStore.getAccountEntry(tabA, {
          kind: "navigation",
          key: "selected-organization",
          tabId: tabA.ownerTabId,
        }),
      ).rejects.toMatchObject({ code: "stale_operation" });
    } finally {
      disposeTabB();
    }
  });

  it("uses injective account+server names and epoch/org/tab row boundaries", async () => {
    const orgA = await createStoreFixture({
      label: "account-state-a",
      accountId: "account-a",
      organizationId: "org-a",
    });
    currentFixture = orgA;
    const entry: AccountStateEntry = {
      kind: "preference",
      key: "selected-repository",
      value: { url: "https://example.test/private.git" },
      updatedAt: 10,
    };
    await store.putEntry(orgA.lease, entry);
    await store.putEntry(orgA.lease, {
      kind: "wizard",
      key: "current-step",
      tabId: orgA.lease.ownerTabId,
      value: { step: 2 },
      updatedAt: 11,
    });
    await expect(store.getEntry(orgA.lease, entry)).resolves.toMatchObject({ value: entry.value });

    const orgB = replaceOrganization(orgA, {
      label: "account-state-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await expect(store.getEntry(orgB.lease, entry)).resolves.toBeNull();
    await expect(
      store.getEntry(orgB.lease, {
        kind: "wizard",
        key: "current-step",
        tabId: orgB.lease.ownerTabId,
      }),
    ).resolves.toBeNull();
    await expect(
      store.getEntry(orgB.lease, {
        kind: "wizard",
        key: "current-step",
        tabId: "owner-tab-other",
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    await expect(
      store.getEntry(forOwnerTab(orgB.lease, "owner-tab-other"), {
        kind: "wizard",
        key: "current-step",
        tabId: "owner-tab-other",
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });

    const orgAReturn = replaceOrganization(orgB, {
      label: "account-state-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    await expect(store.getEntry(orgAReturn.lease, entry)).resolves.toMatchObject({ value: entry.value });

    const sameAccountOtherServer = activation("server-b", SERVER_B, "account-a");
    const otherAccountSameServer = activation("account-b", SERVER_A, "account-b");
    const names = [orgA.activation, sameAccountOtherServer, otherAccountSameServer].map(physicalName);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe(`first-tree-account-state:v1:${orgA.activation.scopeKey}`);
  });

  it("does not reveal a directly seeded residual row from an older epoch in the same scope", async () => {
    const active = await createStoreFixture({
      label: "same-scope-new",
      serverAuthority: SERVER_A,
      accountId: "stable-account",
      organizationId: "org-a",
    });
    currentFixture = active;
    const oldEpoch = activation("same-scope-old", SERVER_A, "stable-account");
    await seedDormantEntry(active.factory, oldEpoch, active.lease.organizationId, {
      kind: "draft",
      key: "chat-1",
      value: { text: "old secret" },
      updatedAt: 1,
    });

    await expect(store.getEntry(active.lease, { kind: "draft", key: "chat-1" })).resolves.toBeNull();
    await store.putEntry(active.lease, {
      kind: "draft",
      key: "chat-1",
      value: { text: "new draft" },
      updatedAt: 2,
    });
    await expect(store.getEntry(active.lease, { kind: "draft", key: "chat-1" })).resolves.toMatchObject({
      value: { text: "new draft" },
    });
  });

  it("cannot read directly seeded residual state for another account or server", async () => {
    const active = await createStoreFixture({
      label: "current-account",
      serverAuthority: SERVER_A,
      accountId: "account-b",
      organizationId: "org-a",
    });
    currentFixture = active;
    const accountA = activation("dormant-account-a", SERVER_A, "account-a");
    const serverB = activation("dormant-server-b", SERVER_B, "account-b");
    const entry: AccountStateEntry = {
      kind: "preference",
      key: "private-repository",
      value: { url: "https://example.test/private.git" },
      updatedAt: 1,
    };
    await seedDormantEntry(active.factory, accountA, "org-a", entry);
    await seedDormantEntry(active.factory, serverB, "org-a", entry);

    await expect(store.getEntry(active.lease, entry)).resolves.toBeNull();
    expect(await databaseNames(active.factory)).toEqual(
      expect.arrayContaining([physicalName(accountA), physicalName(serverB), physicalName(active.activation)]),
    );
  });

  it("cannot read account-partition rows from another account or server", async () => {
    const active = await createStoreFixture({
      label: "current-account-navigation",
      serverAuthority: SERVER_A,
      accountId: "account-b",
      organizationId: "org-a",
    });
    currentFixture = active;
    const accountA = activation("navigation-account-a", SERVER_A, "account-a");
    const serverB = activation("navigation-server-b", SERVER_B, "account-b");
    const entry: AccountStateEntry = {
      kind: "navigation",
      key: "selected-organization",
      tabId: active.accountLease.ownerTabId,
      value: { organizationId: "org-secret" },
      updatedAt: 1,
    };
    await seedDormantAccountEntry(active.factory, accountA, active.accountLease.ownerTabId, entry);
    await seedDormantAccountEntry(active.factory, serverB, active.accountLease.ownerTabId, entry);

    await expect(
      new AccountStateStore().getAccountEntry(active.accountLease, {
        kind: entry.kind,
        key: entry.key,
        tabId: active.accountLease.ownerTabId,
      }),
    ).resolves.toBeNull();
    expect(await databaseNames(active.factory)).toEqual(
      expect.arrayContaining([physicalName(accountA), physicalName(serverB), physicalName(active.activation)]),
    );
  });

  it("prunes atomically and never overwrites an existing row in put-if-absent", async () => {
    const active = await createStoreFixture({ label: "prune", organizationId: "org-a" });
    currentFixture = active;
    await store.putEntry(active.lease, {
      kind: "draft",
      key: "existing",
      value: { text: "newer" },
      updatedAt: 100,
    });
    await expect(
      store.putEntryIfAbsent(
        active.lease,
        { kind: "draft", key: "existing", value: { text: "stale" }, updatedAt: 1 },
        { maxEntries: 2 },
      ),
    ).resolves.toBe(false);

    await store.putEntry(
      active.lease,
      { kind: "draft", key: "middle", value: { text: "middle" }, updatedAt: 50 },
      { maxEntries: 2 },
    );
    await store.putEntry(
      active.lease,
      { kind: "draft", key: "oldest", value: { text: "oldest" }, updatedAt: 2 },
      { maxEntries: 2 },
    );

    await expect(store.getEntry(active.lease, { kind: "draft", key: "existing" })).resolves.toMatchObject({
      value: { text: "newer" },
    });
    await expect(store.getEntry(active.lease, { kind: "draft", key: "middle" })).resolves.not.toBeNull();
    await expect(store.getEntry(active.lease, { kind: "draft", key: "oldest" })).resolves.toBeNull();
  });

  it("lets exactly one concurrent put-if-absent commit", async () => {
    const active = await createStoreFixture({ label: "put-if-absent-race", organizationId: "org-a" });
    currentFixture = active;
    const results = await Promise.all([
      store.putEntryIfAbsent(active.lease, {
        kind: "draft",
        key: "same",
        value: { text: "one" },
        updatedAt: 1,
      }),
      store.putEntryIfAbsent(active.lease, {
        kind: "draft",
        key: "same",
        value: { text: "two" },
        updatedAt: 2,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = await store.getEntry(active.lease, { kind: "draft", key: "same" });
    expect(winner).not.toBeNull();
    expect(["one", "two"]).toContain((winner?.value as { text?: unknown }).text);
  });

  it("snapshots every caller-owned entry field once before storage or compare/exchange", async () => {
    const active = await createStoreFixture({ label: "entry-snapshot", organizationId: "org-a" });
    currentFixture = active;
    const accountStore = new AccountStateStore();
    const lease = active.accountLease;
    const reads = new Map<string, number>();
    const getter =
      <T>(key: string, value: T): (() => T) =>
      () => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
      };
    const original = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, get: getter("put-kind", "state") },
        key: { enumerable: true, get: getter("put-key", "captured") },
        tabId: { enumerable: true, get: getter("put-tab", undefined) },
        value: { enumerable: true, get: getter("put-value", { generation: 1 }) },
        updatedAt: { enumerable: true, get: getter("put-time", 1) },
      },
    ) as AccountStateEntry;
    await accountStore.putAccountEntry(lease, original);
    expect(Object.fromEntries(reads)).toEqual({
      "put-kind": 1,
      "put-key": 1,
      "put-tab": 1,
      "put-value": 1,
      "put-time": 1,
    });

    const current = await accountStore.getAccountEntry(lease, { kind: "state", key: "captured" });
    if (!current) throw new Error("Expected captured account-state entry");
    reads.clear();
    const expected = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, get: getter("expected-kind", current.kind) },
        key: { enumerable: true, get: getter("expected-key", current.key) },
        tabId: { enumerable: true, get: getter("expected-tab", current.tabId) },
        value: { enumerable: true, get: getter("expected-value", current.value) },
        updatedAt: { enumerable: true, get: getter("expected-time", current.updatedAt) },
      },
    ) as AccountStateEntry;
    const replacement = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, get: getter("replacement-kind", "state") },
        key: { enumerable: true, get: getter("replacement-key", "captured") },
        tabId: { enumerable: true, get: getter("replacement-tab", undefined) },
        value: { enumerable: true, get: getter("replacement-value", { generation: 2 }) },
        updatedAt: { enumerable: true, get: getter("replacement-time", 2) },
      },
    ) as AccountStateEntry;
    await expect(
      accountStore.compareExchangeAccountEntry(lease, { kind: "state", key: "captured" }, expected, replacement),
    ).resolves.toMatchObject({ committed: true });
    expect([...reads.values()]).toEqual(new Array(10).fill(1));
    await expect(accountStore.getAccountEntry(lease, { kind: "state", key: "captured" })).resolves.toMatchObject({
      value: { generation: 2 },
    });
  });

  it("rejects non-JSON shapes without sparse-array or prototype escapes", async () => {
    const active = await createStoreFixture({ label: "json-shapes", organizationId: "org-a" });
    currentFixture = active;
    const sparse: unknown[] = [];
    sparse.length = 100;
    sparse[99] = "tail";
    await expect(
      store.putEntry(active.lease, {
        kind: "state",
        key: "sparse",
        value: sparse as never,
        updatedAt: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    let arrayGetterReads = 0;
    const accessorArray = ["safe"];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        arrayGetterReads += 1;
        return "unsafe";
      },
    });
    await expect(
      store.putEntry(active.lease, {
        kind: "state",
        key: "array-accessor",
        value: accessorArray as never,
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(arrayGetterReads).toBe(0);

    const decoratedArray = ["safe"] as unknown[] & { extra?: string };
    decoratedArray.extra = "ignored-by-json";
    await expect(
      store.putEntry(active.lease, {
        kind: "state",
        key: "array-extra",
        value: decoratedArray as never,
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    let getterReads = 0;
    const wide = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index <= 50_000; index += 1) {
      Object.defineProperty(wide, `key-${index}`, {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return index;
        },
      });
    }
    await expect(
      store.putEntry(active.lease, {
        kind: "state",
        key: "wide",
        value: wide as never,
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(getterReads).toBe(0);

    const protoValue = JSON.parse('{"__proto__":{"polluted":true},"safe":"yes"}') as JsonValue;
    await store.putEntry(active.lease, {
      kind: "state",
      key: "proto",
      value: protoValue,
      updatedAt: 3,
    });
    const restored = await store.getEntry(active.lease, { kind: "state", key: "proto" });
    expect(Reflect.getOwnPropertyDescriptor(restored?.value as object, "__proto__")).toBeDefined();
    expect((restored?.value as { __proto__?: unknown }).__proto__).toEqual({ polluted: true });
    expect((restored?.value as { safe?: unknown }).safe).toBe("yes");
    expect(Object.getPrototypeOf(restored?.value)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("aborts pruning when any active-partition row is corrupt and reports no successful put", async () => {
    const active = await createStoreFixture({ label: "prune-corrupt", organizationId: "org-a" });
    currentFixture = active;
    await seedRawEntry(active.factory, active.activation, {
      v: 0,
      sessionEpoch: active.activation.sessionEpoch,
      partitionKind: "organization",
      partitionId: active.lease.organizationId,
      kind: "draft",
      key: "corrupt",
      tabId: "",
      value: { text: "bad" },
      updatedAt: 1,
    });
    await expect(
      store.putEntry(
        active.lease,
        { kind: "draft", key: "new", value: { text: "must roll back" }, updatedAt: 2 },
        { maxEntries: 1 },
      ),
    ).rejects.toMatchObject({ code: "recovery_required" });
    await expect(store.getEntry(active.lease, { kind: "draft", key: "new" })).resolves.toBeNull();
    await expect(store.listEntries(active.lease, { kind: "draft" })).rejects.toMatchObject({
      code: "recovery_required",
    });
  });

  it("rejects corrupt exact rows instead of treating them as a successful put-if-absent collision", async () => {
    const active = await createStoreFixture({ label: "absent-corrupt", organizationId: "org-a" });
    currentFixture = active;
    await seedRawEntry(active.factory, active.activation, {
      v: 0,
      sessionEpoch: active.activation.sessionEpoch,
      partitionKind: "organization",
      partitionId: active.lease.organizationId,
      kind: "draft",
      key: "organization-corrupt",
      tabId: "",
      value: { text: "bad" },
      updatedAt: 1,
    });
    await seedRawEntry(active.factory, active.activation, {
      v: 0,
      sessionEpoch: active.activation.sessionEpoch,
      partitionKind: "account",
      partitionId: "account",
      kind: "navigation",
      key: "account-corrupt",
      tabId: active.accountLease.ownerTabId,
      value: { organizationId: "org-a" },
      updatedAt: 1,
    });

    await expect(
      store.putEntryIfAbsent(active.lease, {
        kind: "draft",
        key: "organization-corrupt",
        value: { text: "replacement" },
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "recovery_required" });
    await expect(
      new AccountStateStore().putAccountEntryIfAbsent(active.accountLease, {
        kind: "navigation",
        key: "account-corrupt",
        tabId: active.accountLease.ownerTabId,
        value: { organizationId: "org-b" },
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("purges before same-account relogin and rejects the retired view after physical-name reuse", async () => {
    const first = await createStoreFixture({
      label: "relogin-first",
      accountId: "same-account",
      organizationId: "org-a",
    });
    currentFixture = first;
    const accountStore = new AccountStateStore();
    const oldAccountLease = first.accountLease;
    await accountStore.putAccountEntry(oldAccountLease, {
      kind: "navigation",
      key: "selected-organization",
      tabId: oldAccountLease.ownerTabId,
      value: { organizationId: "org-a" },
      updatedAt: 1,
    });
    await store.putEntry(first.lease, {
      kind: "draft",
      key: "chat-1",
      value: { text: "secret" },
      updatedAt: 1,
    });
    const databaseName = physicalName(first.activation);

    const relogin = await replaceStoreFixture(first, {
      label: "relogin-second",
      accountId: "same-account",
      organizationId: "org-a",
    });
    currentFixture = relogin;
    expect(await databaseNames(relogin.factory)).not.toContain(databaseName);
    await expect(
      store.putEntry(first.lease, {
        kind: "draft",
        key: "late",
        value: { text: "late secret" },
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });
    await expect(
      accountStore.putAccountEntry(oldAccountLease, {
        kind: "navigation",
        key: "late",
        tabId: oldAccountLease.ownerTabId,
        value: { organizationId: "org-old" },
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });

    await store.putEntry(relogin.lease, {
      kind: "draft",
      key: "current",
      value: { text: "current draft" },
      updatedAt: 3,
    });
    expect(await databaseNames(relogin.factory)).toContain(databaseName);
    await expect(
      store.putEntry(first.lease, {
        kind: "draft",
        key: "late-again",
        value: { text: "late secret" },
        updatedAt: 4,
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });
    await expect(store.getEntry(relogin.lease, { kind: "draft", key: "current" })).resolves.toMatchObject({
      value: { text: "current draft" },
    });
    const newAccountLease = relogin.accountLease;
    await expect(
      accountStore.getAccountEntry(newAccountLease, {
        kind: "navigation",
        key: "selected-organization",
        tabId: newAccountLease.ownerTabId,
      }),
    ).resolves.toBeNull();
  });
});
