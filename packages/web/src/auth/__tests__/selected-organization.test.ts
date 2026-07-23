import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreFixture, ImmediateTestLocks, type StoreFixture } from "../../api/__tests__/scoped-store-fixture.js";
import { AccountStateStore } from "../../api/account-state-store.js";
import {
  SelectedOrganizationController,
  type SelectedOrganizationPublication,
  type SelectedOrganizationState,
} from "../selected-organization.js";
import { captureContentStoreRuntime } from "../session/content-store-runtime.js";
import { closeCoordinatorConnections } from "../session/coordinator.js";
import { type AccountLease, createAccountLease } from "../session/types.js";

let currentFixture: StoreFixture | null = null;

afterEach(() => {
  currentFixture?.dispose();
  currentFixture = null;
  closeCoordinatorConnections();
  vi.restoreAllMocks();
});

function accountLease(fixture: StoreFixture, signal?: AbortSignal): AccountLease {
  if (!signal) return fixture.accountLease;
  return createAccountLease({
    activation: fixture.activation,
    accountRevision: `${fixture.accountLease.accountRevision}-alternate`,
    ownerTabId: fixture.lease.ownerTabId,
    documentId: fixture.lease.documentId,
    signal,
  });
}

function controller(_fixture: StoreFixture, revisions: string[], store = new AccountStateStore()) {
  let index = 0;
  return new SelectedOrganizationController({
    store,
    barrier: _fixture.barrier,
    locks: new ImmediateTestLocks(),
    createRevision: () => revisions[index++] ?? `revision-${index}`,
    now: () => index,
  });
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

async function verifiedIdentity(
  fixture: StoreFixture,
  membershipIds: readonly string[],
  defaultOrganizationId: string | null = null,
) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        user: { id: fixture.activation.accountId },
        defaultOrganizationId,
        memberships: membershipIds.map((organizationId) => ({ organizationId })),
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
  );
  return (await fixture.coordinator.requestActiveMe(fixture.accountLease)).proof;
}

async function reconcile(
  selected: SelectedOrganizationController,
  input: Parameters<SelectedOrganizationController["reconcile"]>[0],
) {
  const result = await selected.reconcile(input);
  const state = result.kind === "superseded" ? null : (selected.readCurrentPublication()?.state ?? null);
  return { ...result, state };
}

function publishedState(result: Readonly<{ state: SelectedOrganizationState | null }>): SelectedOrganizationState {
  if (!result.state) throw new Error("Expected selected-organization publication");
  return result.state;
}

function supersededCursor(result: Awaited<ReturnType<typeof reconcile>>): SelectedOrganizationState {
  if (result.kind !== "superseded") throw new Error("Expected selected-organization observation");
  return result.cursor;
}

function selectedViewPublication(publication: SelectedOrganizationPublication | null): Readonly<{
  state: SelectedOrganizationState;
  viewLease: NonNullable<SelectedOrganizationPublication["viewLease"]>;
}> {
  if (!publication?.viewLease) throw new Error("Expected selected view publication");
  return { state: publication.state, viewLease: publication.viewLease };
}

describe("SelectedOrganizationController", () => {
  it("seeds only a verified default and never falls back to the first membership", async () => {
    const fixture = await createStoreFixture({ label: "selection-initialize", organizationId: "org-view" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-default", "revision-needs"]);
    const lease = accountLease(fixture);

    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-first", "org-default"], "org-default"),
        reason: "initialize",
      }),
    ).resolves.toEqual({
      kind: "committed",
      state: { kind: "selected", organizationId: "org-default", orgRevision: "revision-default" },
    });

    const emptyFixture = await createStoreFixture({ label: "selection-no-default", organizationId: "org-view" });
    currentFixture.dispose();
    currentFixture = emptyFixture;
    const noDefault = controller(emptyFixture, ["revision-needs"]);
    await expect(
      reconcile(noDefault, {
        lease: accountLease(emptyFixture),
        identity: await verifiedIdentity(emptyFixture, ["org-first"], "org-not-a-member"),
        reason: "initialize",
      }),
    ).resolves.toEqual({
      kind: "committed",
      state: { kind: "needs-selection", orgRevision: "revision-needs" },
    });
  });

  it("keeps an explicit needs-selection tombstone until an exact reconciliation observes it", async () => {
    const fixture = await createStoreFixture({ label: "selection-tombstone", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-needs", "revision-unused"]);
    const lease = accountLease(fixture);
    const first = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a"]),
      reason: "initialize",
    });
    expect(first.state).toEqual({ kind: "needs-selection", orgRevision: "revision-needs" });

    const observed = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a"], "org-a"),
      reason: "initialize",
    });
    expect(observed).toEqual({
      kind: "superseded",
      cursor: { kind: "needs-selection", orgRevision: "revision-needs" },
      state: null,
    });
    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a"], "org-a"),
        expectedState: supersededCursor(observed),
        reason: "refresh",
      }),
    ).resolves.toEqual({ kind: "unchanged", state: { kind: "needs-selection", orgRevision: "revision-needs" } });
  });

  it("atomically switches and makes a late refresh of the old source superseded", async () => {
    const fixture = await createStoreFixture({ label: "selection-switch", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-b", "revision-late"]);
    const lease = accountLease(fixture);
    const initialized = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const source = publishedState(initialized);
    const switched = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
      requestedOrganizationId: "org-b",
      expectedState: source,
      reason: "switch",
    });
    expect(switched).toEqual({
      kind: "committed",
      state: { kind: "selected", organizationId: "org-b", orgRevision: "revision-b" },
    });

    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a"]),
        expectedState: source,
        reason: "refresh",
      }),
    ).resolves.toEqual({ kind: "superseded", cursor: publishedState(switched), state: null });

    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
        expectedState: publishedState(switched),
        reason: "refresh",
      }),
    ).resolves.toEqual({ kind: "unchanged", state: publishedState(switched) });
  });

  it("installs the durable selected head before synchronous UI publication and retires the prior view", async () => {
    const fixture = await createStoreFixture({ label: "selection-publication", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-b"]);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const firstSelected = selectedViewPublication(selected.readCurrentPublication());
    const firstView = firstSelected.viewLease;
    const firstState = firstSelected.state;
    expect(firstView).toMatchObject({ organizationId: "org-a", orgRevision: "revision-a" });
    expect(captureContentStoreRuntime(firstView)).not.toBeNull();

    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
      requestedOrganizationId: "org-b",
      expectedState: firstState,
      reason: "switch",
    });
    const secondSelected = selectedViewPublication(selected.readCurrentPublication());
    expect(captureContentStoreRuntime(firstView)).toBeNull();
    expect(captureContentStoreRuntime(secondSelected.viewLease)).not.toBeNull();
    expect(secondSelected.viewLease).toMatchObject({ organizationId: "org-b", orgRevision: "revision-b" });

    await expect(
      selected.reconcile({
        lease,
        identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
        expectedState: firstState,
        reason: "refresh",
      }),
    ).resolves.toMatchObject({ kind: "superseded" });
    expect(captureContentStoreRuntime(secondSelected.viewLease)).not.toBeNull();
  });

  it("rotates an exact suspended selected head and publishes only the fresh view", async () => {
    const fixture = await createStoreFixture({ label: "selection-offline-rebind", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-rebound"]);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a"], "org-a"),
      reason: "initialize",
    });
    const beforePublication = selected.readCurrentPublication();
    const before = selectedViewPublication(beforePublication);
    if (!beforePublication) throw new Error("Expected selected publication");

    const rebound = await selected.rebindSuspendedPublication({
      lease,
      publication: beforePublication,
    });
    const reboundSelected = selectedViewPublication(rebound);

    expect(reboundSelected.state).toEqual({
      kind: "selected",
      organizationId: "org-a",
      orgRevision: "revision-rebound",
    });
    expect(reboundSelected.viewLease).not.toBe(before.viewLease);
    expect(captureContentStoreRuntime(before.viewLease)).toBeNull();
    expect(captureContentStoreRuntime(reboundSelected.viewLease)).not.toBeNull();
    await expect(
      new AccountStateStore().getAccountEntry(lease, {
        kind: "selected-organization",
        key: "current",
        tabId: lease.ownerTabId,
      }),
    ).resolves.toMatchObject({
      value: {
        state: "selected",
        organizationId: "org-a",
        orgRevision: "revision-rebound",
      },
    });
  });

  it("rotates an exact suspended needs-selection head without inventing an organization", async () => {
    const fixture = await createStoreFixture({ label: "selection-offline-needs", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-needs", "revision-needs-rebound"]);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a"]),
      reason: "initialize",
    });
    const before = selected.readCurrentPublication();
    expect(before).toEqual({
      state: { kind: "needs-selection", orgRevision: "revision-needs" },
      viewLease: null,
    });
    if (!before) throw new Error("Expected needs-selection publication");

    await expect(selected.rebindSuspendedPublication({ lease, publication: before })).resolves.toEqual({
      state: { kind: "needs-selection", orgRevision: "revision-needs-rebound" },
      viewLease: null,
    });
  });

  it("fails closed instead of following a selected head changed during suspension", async () => {
    const fixture = await createStoreFixture({ label: "selection-offline-changed", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-unused"]);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const before = selected.readCurrentPublication();
    if (!before) throw new Error("Expected selected publication");
    await new AccountStateStore().putAccountEntry(lease, {
      kind: "selected-organization",
      key: "current",
      tabId: lease.ownerTabId,
      value: { state: "selected", organizationId: "org-b", orgRevision: "external-revision" },
      updatedAt: 99,
    });

    await expect(selected.rebindSuspendedPublication({ lease, publication: before })).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(selected.readCurrentPublication()).toBe(before);
  });

  it("preserves a completed switch when a cursor-free older initialization arrives later", async () => {
    const fixture = await createStoreFixture({ label: "selection-late-initialize", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-b", "revision-unused"]);
    const lease = accountLease(fixture);
    const initialized = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const switched = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
      requestedOrganizationId: "org-b",
      expectedState: publishedState(initialized),
      reason: "switch",
    });

    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
        reason: "initialize",
      }),
    ).resolves.toEqual({ kind: "superseded", cursor: publishedState(switched), state: null });
    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
        expectedState: publishedState(switched),
        reason: "refresh",
      }),
    ).resolves.toEqual({ kind: "unchanged", state: publishedState(switched) });
  });

  it("rejects an installed view after another document advances the durable selected head", async () => {
    const fixture = await createStoreFixture({ label: "selection-durable-head", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-b"]);
    const lease = accountLease(fixture);
    const initialized = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
      requestedOrganizationId: "org-b",
      expectedState: publishedState(initialized),
      reason: "switch",
    });
    const selectedB = selectedViewPublication(selected.readCurrentPublication());
    const staleRuntime = captureContentStoreRuntime(selectedB.viewLease);
    if (!staleRuntime) throw new Error("Expected installed view to remain locally captured");
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseOperation = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const inFlight = staleRuntime.withShared(async () => {
      markEntered();
      await held;
      return "stale-result";
    });
    await entered;

    const store = new AccountStateStore();
    const locator = { kind: "selected-organization", key: "current", tabId: lease.ownerTabId } as const;
    const current = await store.getAccountEntry(lease, locator);
    if (!current) throw new Error("Expected durable selected-organization head");
    await expect(
      store.compareExchangeAccountEntry(lease, locator, current, {
        kind: locator.kind,
        key: locator.key,
        tabId: locator.tabId,
        value: { state: "selected", organizationId: "org-c", orgRevision: "revision-c" },
        updatedAt: current.updatedAt + 1,
      }),
    ).resolves.toMatchObject({ committed: true });

    releaseOperation();
    await expect(inFlight).rejects.toMatchObject({ code: "stale_operation" });
    const callback = vi.fn();
    await expect(staleRuntime.withShared(callback)).rejects.toMatchObject({ code: "stale_operation" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects an older membership proof after a newer active me request starts", async () => {
    const fixture = await createStoreFixture({ label: "selection-proof-order", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a"]);
    const lease = accountLease(fixture);
    const staleIdentity = await verifiedIdentity(fixture, ["org-a"], "org-a");
    const currentIdentity = await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a");
    await expect(selected.reconcile({ lease, identity: staleIdentity, reason: "initialize" })).rejects.toMatchObject({
      code: "stale_operation",
    });
    await expect(reconcile(selected, { lease, identity: currentIdentity, reason: "initialize" })).resolves.toEqual({
      kind: "committed",
      state: { kind: "selected", organizationId: "org-a", orgRevision: "revision-a" },
    });
  });

  it.each([
    "before-commit",
    "after-commit",
  ] as const)("keeps the selected head coherent when a newer active me fails %s", async (boundary) => {
    const fixture = await createStoreFixture({ label: `selection-proof-${boundary}`, organizationId: "org-a" });
    currentFixture = fixture;
    const store = new AccountStateStore();
    const selected = controller(fixture, ["revision-a", "revision-b"], store);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const initial = selectedViewPublication(selected.readCurrentPublication());
    const oldRuntime = captureContentStoreRuntime(initial.viewLease);
    if (!oldRuntime) throw new Error("Expected initial selected runtime");
    const identity = await verifiedIdentity(fixture, ["org-a", "org-b"]);
    const entered = deferred();
    const release = deferred();
    const originalExchange = store.compareExchangeAccountEntry.bind(store);
    vi.spyOn(store, "compareExchangeAccountEntry").mockImplementationOnce(async (...args) => {
      if (boundary === "before-commit") {
        entered.resolve();
        await release.promise;
        return originalExchange(...args);
      }
      const result = await originalExchange(...args);
      entered.resolve();
      await release.promise;
      return result;
    });

    const switching = selected.reconcile({
      lease,
      identity,
      requestedOrganizationId: "org-b",
      expectedState: initial.state,
      reason: "switch",
    });
    await entered.promise;

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("offline"));
    await expect(fixture.coordinator.requestActiveMe(lease)).rejects.toMatchObject({
      code: "admission_denied",
    });
    release.resolve();

    await expect(switching).resolves.toEqual({ kind: "committed" });
    const current = selectedViewPublication(selected.readCurrentPublication());
    expect(current.state).toEqual({
      kind: "selected",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    const locator = { kind: "selected-organization", key: "current", tabId: lease.ownerTabId } as const;
    await expect(store.getAccountEntry(lease, locator)).resolves.toMatchObject({
      value: { state: "selected", organizationId: "org-b", orgRevision: "revision-b" },
    });
    await expect(oldRuntime.withShared(() => "stale")).rejects.toMatchObject({ code: "stale_operation" });
    const currentRuntime = captureContentStoreRuntime(current.viewLease);
    if (!currentRuntime) throw new Error("Expected current selected runtime");
    await expect(currentRuntime.withShared(() => "usable")).resolves.toBe("usable");
  });

  it("does not invoke caller-supplied callbacks that could retain an async publication", async () => {
    const fixture = await createStoreFixture({ label: "selection-no-callback", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a"]);
    const identity = await verifiedIdentity(fixture, ["org-a"], "org-a");
    const escaped = vi.fn(async () => Promise.resolve());

    await expect(
      (selected.reconcile as unknown as (input: unknown, ignored: unknown) => Promise<unknown>)(
        { lease: accountLease(fixture), identity, reason: "initialize" },
        escaped,
      ),
    ).resolves.toMatchObject({ kind: "committed" });
    expect(escaped).not.toHaveBeenCalled();
  });

  it("commits needs-selection when the selected membership disappears", async () => {
    const fixture = await createStoreFixture({ label: "selection-disappeared", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-needs"]);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const initialSelected = selectedViewPublication(selected.readCurrentPublication());
    expect(captureContentStoreRuntime(initialSelected.viewLease)).not.toBeNull();

    await expect(
      selected.reconcile({
        lease,
        identity: await verifiedIdentity(fixture, ["org-b"], "org-b"),
        expectedState: initialSelected.state,
        reason: "refresh",
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(selected.readCurrentPublication()).toEqual({
      state: { kind: "needs-selection", orgRevision: "revision-needs" },
      viewLease: null,
    });
    expect(captureContentStoreRuntime(initialSelected.viewLease)).toBeNull();
  });

  it("does not restore an observed selected head after that membership disappears", async () => {
    const fixture = await createStoreFixture({ label: "selection-initialize-disappeared", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-needs"]);
    const lease = accountLease(fixture);
    await selected.reconcile({
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const initialSelected = selectedViewPublication(selected.readCurrentPublication());

    await expect(
      selected.reconcile({
        lease,
        identity: await verifiedIdentity(fixture, ["org-b"], "org-b"),
        expectedState: initialSelected.state,
        reason: "initialize",
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(selected.readCurrentPublication()).toEqual({
      state: { kind: "needs-selection", orgRevision: "revision-needs" },
      viewLease: null,
    });
    expect(captureContentStoreRuntime(initialSelected.viewLease)).toBeNull();
  });

  it("observes an existing head before a fresh proof restores it with a new revision", async () => {
    const fixture = await createStoreFixture({ label: "selection-org-runtime", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-restored"]);
    const lease = accountLease(fixture);
    const initialized = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a"], "org-a"),
      reason: "initialize",
    });
    expect(publishedState(initialized)).toEqual({
      kind: "selected",
      organizationId: "org-a",
      orgRevision: "revision-a",
    });

    const observedIdentity = await verifiedIdentity(fixture, ["org-a", "org-b"]);
    const observed = await reconcile(selected, {
      lease,
      identity: observedIdentity,
      reason: "initialize",
    });
    expect(observed).toEqual({ kind: "superseded", cursor: publishedState(initialized), state: null });
    await expect(
      reconcile(selected, {
        lease,
        identity: observedIdentity,
        requestedOrganizationId: "org-a",
        expectedState: supersededCursor(observed),
        reason: "restore",
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });
    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a", "org-b"]),
        requestedOrganizationId: "org-a",
        expectedState: supersededCursor(observed),
        reason: "restore",
      }),
    ).resolves.toEqual({
      kind: "committed",
      state: { kind: "selected", organizationId: "org-a", orgRevision: "revision-restored" },
    });
  });

  it("rejects invalid switches, missing source cursors, and aborted account leases", async () => {
    const fixture = await createStoreFixture({ label: "selection-invalid", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a"]);
    const lease = accountLease(fixture);
    const initialized = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a"], "org-a"),
      reason: "initialize",
    });

    await expect(
      reconcile(selected, {
        lease,
        identity: await verifiedIdentity(fixture, ["org-a"]),
        requestedOrganizationId: "org-b",
        expectedState: publishedState(initialized),
        reason: "switch",
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    await expect(
      reconcile(selected, { lease, identity: await verifiedIdentity(fixture, ["org-a"]), reason: "refresh" }),
    ).rejects.toMatchObject({
      code: "invalid_state",
    });

    const controllerSignal = new AbortController();
    controllerSignal.abort();
    await expect(
      reconcile(selected, {
        lease: accountLease(fixture, controllerSignal.signal),
        identity: await verifiedIdentity(fixture, ["org-a"]),
        reason: "initialize",
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });
  });

  it("snapshots caller-owned membership and source inputs before the first await", async () => {
    const fixture = await createStoreFixture({ label: "selection-snapshot", organizationId: "org-a" });
    currentFixture = fixture;
    const selected = controller(fixture, ["revision-a", "revision-b"]);
    const lease = accountLease(fixture);
    const initialized = await reconcile(selected, {
      lease,
      identity: await verifiedIdentity(fixture, ["org-a", "org-b"], "org-a"),
      reason: "initialize",
    });
    const memberships = ["org-a", "org-b"];
    const source = publishedState(initialized);
    const identity = await verifiedIdentity(fixture, memberships);
    const pending = reconcile(selected, {
      lease,
      identity,
      requestedOrganizationId: "org-b",
      expectedState: source,
      reason: "switch",
    });
    memberships.splice(0, memberships.length, "org-a");
    await expect(pending).resolves.toEqual({
      kind: "committed",
      state: { kind: "selected", organizationId: "org-b", orgRevision: "revision-b" },
    });
  });
});
