import { SheetSource } from "../../../src/sources.mjs";

// Read a spreadsheet/CSV of links into a list of http(s) URLs using the
// engine's SheetSource (so header detection matches the CLI exactly).
// load() never writes to the file; only setStatus/setReason do.
export async function importSheet(filePath, logger) {
  const source = new SheetSource(filePath, logger);
  const jobs = await source.load();
  return jobs.map((job) => job.url);
}
