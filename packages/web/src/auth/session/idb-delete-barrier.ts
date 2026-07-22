import { sessionErrorCodes, toSessionError } from "./errors.js";

/** Keep a blocked delete alive until IndexedDB reports its terminal result. */
export function deleteDatabaseBarrier(
  factory: IDBFactory,
  databaseName: string,
  onBlocked?: (databaseName: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(databaseName);
    } catch (error) {
      reject(toSessionError(error, sessionErrorCodes.persistenceUnavailable, "Database deletion could not start"));
      return;
    }
    request.onblocked = () => onBlocked?.(databaseName);
    request.onerror = () => {
      reject(toSessionError(request.error, sessionErrorCodes.persistenceUnavailable, "Database deletion failed"));
    };
    request.onsuccess = () => resolve();
  });
}
