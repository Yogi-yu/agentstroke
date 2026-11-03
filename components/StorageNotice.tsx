"use client";

import { appStore, useApp } from "@/state/appStore";

/** Storage failures are not success states, even when the live canvas still works. */
export default function StorageNotice() {
  const { storageError } = useApp();
  if (!storageError) return null;
  return (
    <div className="storage-notice" role="alert">
      <span>{storageError}</span>
      <button type="button" onClick={() => appStore.dismissStorageError()} aria-label="Dismiss storage message">Dismiss</button>
    </div>
  );
}
