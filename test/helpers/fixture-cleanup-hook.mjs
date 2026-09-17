import { setupFixtureAutoCleanup, pruneStaleFixtures } from './fixture-helper.mjs';

// Install automatic lifecycle hooks and fs.mkdtempSync interception
setupFixtureAutoCleanup();

// Prune any stale fixtures left behind by previous aborted runs
try {
  pruneStaleFixtures();
} catch (err) {
  // Prune errors should never block test execution
}
