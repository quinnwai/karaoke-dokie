// Writes an identity audit for one signed-in person's library: how their Spotify listings group into
// songs (src/lib/songs/identity.ts) and what looks doubtful (src/lib/report/identityAudit.ts).
// Writes nothing to the database except the normal Spotify token refresh (and the schema check the app
// runs on connect). Puts the library and the audit in a local folder, git-ignored, that you delete after.
// Usage: npm run audit:identity -- [spotifyUserId] [--env .env.local] [--out identity-audit]
//                                  [--library identity-audit/library.json] [--refresh] [--no-database]
//   Needs DATABASE_URL and the Spotify keys, read from --env (default .env.local) when that file exists.
//   Reads the library from Spotify the way the app does when it opens (one request at a time, a few
//   hundred in all, stopping at the first HTTP 429), then writes <out>/audit.csv and <out>/library.json.
//   With --library it reads a saved copy instead and makes no Spotify calls, so reruns cost nothing;
//   without it, a saved <out>/library.json is not read over again unless you pass --refresh.
//   --no-database skips the stored-range and USDB checks. The library read is the app's: up to 2,000
//   saved songs, 3,000 songs from up to 100 of your own playlists, the top 50 for each of three spans
//   and the last 50 plays. Both files hold your library (titles, ISRCs, track ids): mode 600, meant to
//   be deleted when you are done.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { identityAudit, identityAuditCsv, identityAuditText } from '../src/lib/report/identityAudit';
import { AuditStop, parseArgs, readLibraryStrictly, slimListening, sourcesOf, UsageError } from '../src/lib/report/identityAuditRun';
import { readConfig } from '../src/lib/server/config';
import { getStore, pickStoreKind } from '../src/lib/server/getStore';
import { buildLibrary, type Listening } from '../src/lib/server/spotify';
import { songKey } from '../src/lib/songs/resolve';

const USAGE = `Usage: npm run audit:identity -- [spotifyUserId] [--env .env.local] [--out identity-audit] [--library file.json] [--refresh] [--no-database]`;

function write(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600); // the mode above only applies when the file is created
}

async function main() {
  const { flags, userId: userArg } = parseArgs(process.argv.slice(2));
  if (flags.has('--help')) return console.log(USAGE);
  const envFile = (flags.get('--env') as string | undefined) ?? '.env.local';
  const out = (flags.get('--out') as string | undefined) ?? 'identity-audit';
  const savedLibrary = flags.get('--library') as string | undefined;
  const useDatabase = !flags.has('--no-database');

  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides a variable already set in the shell
  else if (flags.has('--env')) throw new AuditStop(`No such env file: ${envFile}`);
  if (!savedLibrary && existsSync(`${out}/library.json`) && !flags.has('--refresh')) {
    throw new AuditStop(`${out}/library.json already holds a read of Spotify. Rerun on it with --library ${out}/library.json (no Spotify calls), or pass --refresh to read Spotify again.`);
  }
  mkdirSync(out, { recursive: true }); // before any network call, so a bad --out costs nothing
  if (useDatabase) {
    if (pickStoreKind() !== 'postgres') {
      throw new AuditStop(`No database: DATABASE_URL is not set, or KARAOKE_STORE=memory is. Put DATABASE_URL in ${envFile} or export it (the Neon string usdb:sync uses), or pass --no-database.`);
    }
    let host: string;
    try {
      host = new URL(process.env.DATABASE_URL!).host;
    } catch {
      throw new AuditStop('DATABASE_URL is not a valid URL (the value is not shown).');
    }
    console.log(`Database: ${host}`);
  }
  const store = useDatabase ? getStore() : null;

  // ---- the library ----
  let who: string;
  let listening: Listening;
  let requests = 0;
  let problems: string[] = [];
  if (savedLibrary) {
    const file = JSON.parse(readFileSync(savedLibrary, 'utf8')) as { who?: string; listening?: Listening; problems?: string[] };
    if (!file.listening?.top || !Array.isArray(file.listening.saved) || !Array.isArray(file.listening.recent)) {
      throw new AuditStop(`${savedLibrary} is not a library saved by this script (no "listening")`);
    }
    who = file.who ?? savedLibrary;
    listening = file.listening;
    problems = file.problems ?? [];
    console.log(`Reading ${savedLibrary}: no Spotify calls.`);
  } else {
    if (!store) throw new AuditStop('Reading Spotify needs the database for the saved sign-in: drop --no-database, or pass --library.');
    const read = await readLibraryStrictly({
      store,
      config: readConfig().spotify,
      ...(userArg ? { userId: userArg } : {}),
      announce: (name) => console.log(`Reading the library of ${name}: about to call Spotify, one request at a time.`),
    });
    ({ who, listening, requests, problems } = read);
    write(`${out}/library.json`, JSON.stringify({ who, takenAt: new Date().toISOString(), problems, listening: slimListening(listening) }));
  }

  // ---- the audit ----
  const tracks = buildLibrary(listening);
  const keys = [...new Set(tracks.map((t) => songKey(t.artist, t.title)))];
  const audit = identityAudit({
    tracks,
    sources: sourcesOf(listening),
    ...(store ? { ranges: await store.getSongRanges(keys), usdbIndex: await store.listUsdbSongs() } : {}),
  });
  write(`${out}/audit.csv`, identityAuditCsv(audit.rows));

  console.log(`\nIdentity audit for ${who}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${requests ? `, ${requests} Spotify requests` : ''}\n`);
  if (problems.length) {
    console.log(`WARNING: the library is PARTIAL. Spotify failed some reads: ${problems.join('; ')}. The numbers below miss what those reads would have added.\n`);
    process.exitCode = 2;
  }
  console.log(identityAuditText(audit));
  console.log(`Files: ${out}/audit.csv${savedLibrary ? '' : ` and ${out}/library.json`}. They hold your library: delete the folder when you are done${out === 'identity-audit' ? '' : ' (and keep it out of git)'}.`);
}

/** An error message with the database string and the Spotify secret taken out, whatever library raised it. */
function redact(message: string): string {
  return [process.env.DATABASE_URL, process.env.SPOTIFY_CLIENT_SECRET]
    .filter((secret): secret is string => !!secret?.trim())
    .reduce((text, secret) => text.split(secret).join('[redacted]'), message);
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  if (err instanceof UsageError) console.error(USAGE);
  process.exit(1);
});
