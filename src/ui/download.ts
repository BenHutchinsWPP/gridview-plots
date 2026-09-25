// src/ui/download.ts
//
// Hands a Blob to the browser as a file download. Every export in the app
// (CSV, figure, bundle, group file) leaves through here.
//
// The object URL is revoked a minute later, not at once: revoking it
// synchronously races the download it started.

/** Offer `blob` to the browser as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
