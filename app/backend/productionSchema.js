// Creates every production-workflow table, in dependency order, each step on
// its own: one failing step is logged and the rest still run (later steps
// that depend on it will log their own error), instead of silently skipping
// everything after it.
//
//   production assets/imports/issues  ->  media files  ->  design tasks  ->  submissions
//   (submissions point at tasks AND media files, so they must come last)

import { ensureProductionSchema } from "./production.js";
import { ensureMediaSchema } from "./mediaStore.js";
import { ensureDesignTaskSchema } from "./designTasks.js";
import { ensureSubmissionSchema } from "./designSubmissions.js";
import { ensureScreenplayAnalysisSchema } from "./screenplayAnalysis.js";

export async function ensureAllProductionSchemas(db, log = console.error) {
  const steps = [
    ["production dossier", ensureProductionSchema],
    ["media storage", ensureMediaSchema],
    ["designer tasks", ensureDesignTaskSchema],
    ["designer submissions", ensureSubmissionSchema],
    ["screenplay scenes", ensureScreenplayAnalysisSchema],
  ];
  const failures = [];
  for (const [name, step] of steps) {
    try {
      await step(db);
    } catch (error) {
      failures.push({ step: name, error: error.message });
      log(`Production schema setup failed (${name}):`, error.message);
    }
  }
  return failures;
}
