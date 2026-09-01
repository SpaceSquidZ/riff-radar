// scripts/loadEnv.mjs
//
// Loads .env then .env.local into process.env, with .env.local values
// winning on conflict -- the same precedence Vite gives them for the app
// itself. Node's process.loadEnvFile() never overwrites a key already set,
// so the only way to make the *later*-loaded file win is to load it
// *first*: .env.local goes first (its values land), then .env fills in
// anything .env.local didn't define. Verified empirically before relying on
// it (loadEnvFile's overwrite behavior isn't obvious from its name).
//
// This exists because relying on the caller to `source .env && source
// .env.local` in the shell before running a script is exactly the kind of
// silent split-brain that let LASTFM_API_KEY and SUPABASE_SERVICE_ROLE_KEY
// live in .env.local while callers only sourced .env: no error, just quiet
// fallback behavior with no signal anything was missing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadRepoEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path.join(repoRoot, file));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}
