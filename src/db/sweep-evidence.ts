import { pool } from "@/db/client";
import { sweepEvidenceStorage } from "@/lib/evidence-cleanup";

async function main() {
  try {
    const result = await sweepEvidenceStorage();
    console.log(`Evidence cleanup: ${result.deleted} deleted, ${result.orphans} orphan(s), ${result.pending} pending.`);
  } finally {
    await pool.end();
  }
}
void main();
