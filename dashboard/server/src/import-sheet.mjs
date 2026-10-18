import { SheetSource } from "../../../src/sources.mjs";

// Read a spreadsheet/CSV of links into `{ url, name }` rows using the engine's
// SheetSource (so header + name/title column detection matches the CLI exactly).
// `name` is null when the sheet has no name column (or the cell is blank).
// load() never writes to the file; only setStatus/setReason do.
export async function importSheet(filePath, logger) {
  const source = new SheetSource(filePath, logger);
  const jobs = await source.load();
  return jobs.map((job) => ({ url: job.url, name: job.name ?? null }));
}
