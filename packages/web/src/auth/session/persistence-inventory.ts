/**
 * The complete physical account-content inventory. Store schemas consume the
 * same descriptors; logout uses them to derive every account+server database
 * name without accepting a caller-selected deletion list.
 */
export const PERSISTENT_CONTENT_DATABASES = Object.freeze({
  chatContent: Object.freeze({ logicalName: "chat-content", namespaceVersion: 1 }),
  imageContent: Object.freeze({ logicalName: "image-content", namespaceVersion: 1 }),
  accountState: Object.freeze({ logicalName: "first-tree-account-state", namespaceVersion: 1 }),
});

export const PERSISTENT_CONTENT_DATABASE_INVENTORY = Object.freeze(Object.values(PERSISTENT_CONTENT_DATABASES));
