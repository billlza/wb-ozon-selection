import fs from "node:fs/promises";
import path from "node:path";
import { assessC1DraftRecovery, assessC1DraftEditorialCorrection } from "../lib/c1-draft-recovery-assessment.mjs";

// Offline maintenance only: explicit normalized snapshots in, a new proposal
// report out. No gateway client, business repository, or application action.
const args = process.argv.slice(2);
if (![8, 10].includes(args.length) || args[0] !== "--request" || args[2] !== "--receipt" ||
    args[4] !== "--source-job" || args[6] !== "--output" || (args.length === 10 && args[8] !== "--correction-plan")) {
  throw new Error("Usage: assess-c1-draft-recovery.mjs --request snapshot.json --receipt normalized-receipt.json --source-job job.json --output new-report.json [--correction-plan reviewed-plan.json]");
}
async function readSnapshot(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 2_000_000) throw new Error("C1_RECOVERY_SNAPSHOT_SIZE_INVALID");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
const [request, receipt, sourceJob] = await Promise.all([args[1], args[3], args[5]].map(readSnapshot));
const report = args.length === 10
  ? assessC1DraftEditorialCorrection({ request, receipt, sourceJob, correctionPlan: await readSnapshot(args[9]) })
  : assessC1DraftRecovery({ request, receipt, sourceJob });
const destination = path.resolve(args[7]);
await fs.writeFile(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: report.status,
  repairedVersionCreated: report.repairedVersion != null, editedVersionCreated: report.editedVersion != null,
  networkRequests: 0, businessWrites: 0, reportFile: destination }));
