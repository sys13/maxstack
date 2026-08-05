/**
 * Run with `tsx prd/validate.ts` (wired into the `ship-check` skill and CI).
 * Imports the project's prd.ts, runs validatePRD, and exits non-zero on
 * referential-integrity failure so a broken PRD can't silently ship.
 */
import { validatePRD } from "./prd.schema";
import { prd } from "../prd";

try {
  validatePRD(prd);
  console.log("prd.ts: valid");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
