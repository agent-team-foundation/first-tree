import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_CONTENT_DATABASE_SPEC,
  closeCoordinatorConnections,
  createScopedDatabaseName,
  IMAGE_CONTENT_DATABASE_SPEC,
  type SessionLockManager,
  type SessionLockOptions,
} from "../../auth/session/index.js";
import { getImage, putImage } from "../image-store.js";
import { clearReadState, getReadState, setReadState } from "../read-state-store.js";
import {
  createStoreFixture,
  putRawStoreRow,
  replaceOrganization,
  replaceStoreFixture,
  type StoreFixture,
} from "./scoped-store-fixture.js";

let currentFixture: StoreFixture | null = null;

class PausedSharedLock implements SessionLockManager {
  public readonly entered: Promise<void>;
  public releaseError: unknown;
  private markEntered: () => void = () => undefined;
  private releasePaused: (() => Promise<void>) | null = null;
  private pauseNextShared = true;

  public constructor() {
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve;
    });
  }

  public request<T>(_name: string, options: SessionLockOptions, callback: () => T | PromiseLike<T>): Promise<T> {
    if (options.mode !== "shared" || !this.pauseNextShared) return Promise.resolve().then(callback);
    this.pauseNextShared = false;
    this.markEntered();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(new DOMException("Lock cancelled", "AbortError"));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.releasePaused = async () => {
        options.signal?.removeEventListener("abort", abort);
        try {
          resolve(await callback());
        } catch (error) {
          this.releaseError = error;
          reject(error);
        }
      };
    });
  }

  public async release(): Promise<void> {
    await this.releasePaused?.();
  }
}

afterEach(() => {
  currentFixture?.dispose();
  currentFixture = null;
  closeCoordinatorConnections();
});

describe("scoped image store", () => {
  it("preserves the image cache contract for an explicit authenticated view", async () => {
    currentFixture = await createStoreFixture({ label: "image", organizationId: "org-a" });
    await expect(
      putImage(currentFixture.lease, { imageId: "img-1", base64: "abc123", mimeType: "image/png" }),
    ).resolves.toBeUndefined();
    await expect(getImage(currentFixture.lease, "img-1")).resolves.toEqual({
      base64: "abc123",
      mimeType: "image/png",
    });
    await expect(getImage(currentFixture.lease, "missing")).resolves.toBeNull();
  });

  it("returns a cache miss for a malformed persisted image row", async () => {
    currentFixture = await createStoreFixture({ label: "corrupt-image", organizationId: "org-a" });
    const { activation, factory, lease } = currentFixture;
    await putImage(lease, { imageId: "seed", base64: "valid", mimeType: "image/png" });
    const databaseName = createScopedDatabaseName(
      IMAGE_CONTENT_DATABASE_SPEC.logicalName,
      IMAGE_CONTENT_DATABASE_SPEC.namespaceVersion,
      activation.scopeKey,
    );
    await putRawStoreRow(factory, databaseName, "images", {
      organizationId: "org-a",
      imageId: "corrupt",
      base64: 42,
      mimeType: "image/png",
      createdAt: Date.now(),
    });

    await expect(getImage(lease, "corrupt")).resolves.toBeNull();
  });

  it("fails closed for legacy calls without a captured view", async () => {
    await expect(putImage({ imageId: "img-1", base64: "abc123", mimeType: "image/png" })).rejects.toThrow(
      "Image storage unavailable",
    );
    await expect(getImage("img-1")).resolves.toBeNull();
  });

  it("does not expose an image to another organization or a stale lease", async () => {
    const orgA = await createStoreFixture({ label: "image-org-a", accountId: "account", organizationId: "org-a" });
    currentFixture = orgA;
    await putImage(orgA.lease, { imageId: "img-1", base64: "secret-a", mimeType: "image/png" });

    const orgB = replaceOrganization(orgA, {
      label: "image-org-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await expect(getImage(orgB.lease, "img-1")).resolves.toBeNull();
    await expect(getImage(orgA.lease, "img-1")).resolves.toBeNull();
    await putImage(orgB.lease, { imageId: "img-1", base64: "secret-b", mimeType: "image/jpeg" });
    await expect(getImage(orgB.lease, "img-1")).resolves.toEqual({
      base64: "secret-b",
      mimeType: "image/jpeg",
    });
  });

  it("purges departing-account bytes before an account switch", async () => {
    const accountA = await createStoreFixture({ label: "image-a", accountId: "account-a", organizationId: "org" });
    currentFixture = accountA;
    await putImage(accountA.lease, { imageId: "img", base64: "secret-a", mimeType: "image/png" });

    const accountB = await replaceStoreFixture(accountA, {
      label: "image-b",
      accountId: "account-b",
      organizationId: "org",
    });
    currentFixture = accountB;
    await expect(getImage(accountB.lease, "img")).resolves.toBeNull();
    await expect(getImage(accountA.lease, "img")).resolves.toBeNull();
  });

  it("deletes image and read-state databases before same-account relogin", async () => {
    const first = await createStoreFixture({ label: "same-a", accountId: "same-account", organizationId: "org" });
    currentFixture = first;
    await putImage(first.lease, { imageId: "img", base64: "secret", mimeType: "image/png" });
    await setReadState(first.lease, "chat", "bottom", "latest");

    const relogin = await replaceStoreFixture(first, {
      label: "same-a-relogin",
      accountId: "same-account",
      organizationId: "org",
    });
    currentFixture = relogin;
    await expect(getImage(relogin.lease, "img")).resolves.toBeNull();
    await expect(getReadState(relogin.lease, "chat")).resolves.toBeNull();
  });

  it("does not let a queued stale image write run after another organization installs", async () => {
    const locks = new PausedSharedLock();
    const orgA = await createStoreFixture({ label: "late-image-a", organizationId: "org-a" }, locks);
    currentFixture = orgA;
    const lateWriteOutcome = putImage(orgA.lease, {
      imageId: "late-image",
      base64: "secret-a",
      mimeType: "image/png",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await locks.entered;

    const orgB = replaceOrganization(orgA, {
      label: "late-image-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await locks.release();
    const lateWriteError = await lateWriteOutcome;

    expect(locks.releaseError).toMatchObject({ code: "stale_operation" });
    expect(lateWriteError).toMatchObject({ cause: { code: "stale_operation" } });
    await expect(getImage(orgB.lease, "late-image")).resolves.toBeNull();
    const orgAReturn = replaceOrganization(orgB, {
      label: "late-image-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    await expect(getImage(orgAReturn.lease, "late-image")).resolves.toBeNull();
  });

  it("persists image primitives captured before the first await", async () => {
    const locks = new PausedSharedLock();
    currentFixture = await createStoreFixture({ label: "snapshot-image", organizationId: "org-a" }, locks);
    const params = { imageId: "original", base64: "before", mimeType: "image/png" };
    const write = putImage(currentFixture.lease, params);
    await locks.entered;

    params.imageId = "mutated";
    params.base64 = "after";
    params.mimeType = "image/jpeg";
    await locks.release();
    await write;

    await expect(getImage(currentFixture.lease, "original")).resolves.toEqual({
      base64: "before",
      mimeType: "image/png",
    });
    await expect(getImage(currentFixture.lease, "mutated")).resolves.toBeNull();
  });
});

describe("scoped read-state store", () => {
  it("sets, gets, overwrites, and clears within one explicit view", async () => {
    currentFixture = await createStoreFixture({ label: "read", organizationId: "org-a" });
    const { lease } = currentFixture;
    await expect(getReadState(lease, "chat-1")).resolves.toBeNull();

    await setReadState(lease, "chat-1", "msg-1", "msg-3");
    await expect(getReadState(lease, "chat-1")).resolves.toMatchObject({
      chatId: "chat-1",
      bottomVisibleMessageId: "msg-1",
      latestKnownMessageId: "msg-3",
    });

    await setReadState(lease, "chat-1", "msg-4", "msg-5");
    await expect(getReadState(lease, "chat-1")).resolves.toMatchObject({
      bottomVisibleMessageId: "msg-4",
      latestKnownMessageId: "msg-5",
    });
    await clearReadState(lease, "chat-1");
    await expect(getReadState(lease, "chat-1")).resolves.toBeNull();
  });

  it("silently fails closed without an explicit captured view", async () => {
    await expect(setReadState("chat-1", "msg-1", "msg-2")).resolves.toBeUndefined();
    await expect(clearReadState("chat-1")).resolves.toBeUndefined();
    await expect(getReadState("chat-1")).resolves.toBeNull();
  });

  it("returns a cache miss for malformed persisted read state", async () => {
    currentFixture = await createStoreFixture({ label: "corrupt-read", organizationId: "org-a" });
    const { activation, factory, lease } = currentFixture;
    await setReadState(lease, "chat", "bottom", "latest");
    const databaseName = createScopedDatabaseName(
      CHAT_CONTENT_DATABASE_SPEC.logicalName,
      CHAT_CONTENT_DATABASE_SPEC.namespaceVersion,
      activation.scopeKey,
    );
    await putRawStoreRow(factory, databaseName, "read-state", {
      organizationId: "org-a",
      chatId: "corrupt",
      bottomVisibleMessageId: 42,
      latestKnownMessageId: "latest",
      updatedAt: Date.now(),
    });

    await expect(getReadState(lease, "corrupt")).resolves.toBeNull();
  });

  it("rejects old-org state and preserves each organization's independent row", async () => {
    const orgA = await createStoreFixture({ label: "read-a", accountId: "account", organizationId: "org-a" });
    currentFixture = orgA;
    await setReadState(orgA.lease, "chat", "a-bottom", "a-latest");

    const orgB = replaceOrganization(orgA, {
      label: "read-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await expect(getReadState(orgB.lease, "chat")).resolves.toBeNull();
    await expect(getReadState(orgA.lease, "chat")).resolves.toBeNull();
    await setReadState(orgB.lease, "chat", "b-bottom", "b-latest");

    const orgAReturn = replaceOrganization(orgB, {
      label: "read-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    await expect(getReadState(orgAReturn.lease, "chat")).resolves.toMatchObject({
      bottomVisibleMessageId: "a-bottom",
      latestKnownMessageId: "a-latest",
    });
  });

  it("turns a queued stale read-state write into a settled no-op after an organization switch", async () => {
    const locks = new PausedSharedLock();
    const orgA = await createStoreFixture({ label: "late-read-a", organizationId: "org-a" }, locks);
    currentFixture = orgA;
    const lateWrite = setReadState(orgA.lease, "chat", "a-bottom", "a-latest");
    await locks.entered;

    const orgB = replaceOrganization(orgA, {
      label: "late-read-b",
      organizationId: "org-b",
      orgRevision: "revision-b",
    });
    currentFixture = orgB;
    await locks.release();
    await expect(lateWrite).resolves.toBeUndefined();

    expect(locks.releaseError).toMatchObject({ code: "stale_operation" });
    await expect(getReadState(orgB.lease, "chat")).resolves.toBeNull();
    const orgAReturn = replaceOrganization(orgB, {
      label: "late-read-a-return",
      organizationId: "org-a",
      orgRevision: "revision-a-return",
    });
    currentFixture = orgAReturn;
    await expect(getReadState(orgAReturn.lease, "chat")).resolves.toBeNull();
  });
});
