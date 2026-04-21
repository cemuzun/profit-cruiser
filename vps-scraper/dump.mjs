// Standalone "just dump JSON from current Postgres" helper. Useful if you ever
// want to refresh the served files without re-running the scraper.
// Usage (inside container): node dump.mjs
import "./scraper.mjs"; // re-exports nothing; left as placeholder.
