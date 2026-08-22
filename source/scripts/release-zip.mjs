export const RELEASE_ZIP_ENTRY_DATE_MS = Date.UTC(2000, 0, 1, 0, 0, 0);

export function normalizeZipEntryDates(zip) {
  for (const entry of Object.values(zip.files)) {
    entry.date = new Date(RELEASE_ZIP_ENTRY_DATE_MS);
  }
  return zip;
}
