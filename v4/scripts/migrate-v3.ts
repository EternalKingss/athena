import { planV3Migration } from "../src/server/migration/migrateV3.js";

const report = planV3Migration([]);
console.log(JSON.stringify(report, null, 2));
