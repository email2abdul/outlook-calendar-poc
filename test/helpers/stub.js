'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Replace a module with a fake BEFORE anything requires it, by seeding the
 * require cache. Lets these tests exercise the real ingest/enrichment logic
 * with no Supabase, SQLite, Graph or Anthropic behind it.
 *
 *   stub('src/graph', { getUpcomingEvents: async () => [] })
 *
 * @param {string} repoPath module path relative to the repo root
 * @param {object} exports  what `require()` should hand back instead
 */
module.exports = function stub(repoPath, exports) {
  const filename = require.resolve(path.join(ROOT, repoPath));
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return exports;
};
