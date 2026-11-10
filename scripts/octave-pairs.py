"""Reads, from the vocal-range pipeline's data folder (read only), every song that has both a karaoke note file
and a range measured from its recording, and writes what scripts/octave-evidence-build.ts needs.

Usage: python3 -I scripts/octave-pairs.py <pipeline data folder> <out.json>
  e.g. .../ingestion-pipeline/data pairs.json

Per song (Billboard comparison, Sing King and KaraFun catalogs; a song in several is counted once):
  artist, title, recording  the typical note of the recording at the app's definition (app_ranges.tessitura)
  noteAsStored              the note file's typical note after the app's own octave rule (range.ts)
  rap, duet                 recordings of mostly-rap songs are not trusted for pitch; duets are left alone
Also prints the share of note files whose octave disagrees with the recording (nearest octave of the recording).
"""
import json
import sqlite3
import sys
from collections import Counter

src, out = sys.argv[1].rstrip('/') + '/', sys.argv[2]
rows = {}
for r in json.load(open(src + 'app_definition_comparison.json'))['songs']:
    if not r.get('full_app') or r.get('shift_aligned') is None:
        continue
    rows[r['track_id']] = dict(
        artist=r['artist_credit'], title=r['title'], recording=r['full_app']['tessitura'],
        noteAsStored=r['truth']['tessitura'] - (r['shift_aligned'] - r['shift_app']),
        rap=bool(r['mostly_rap']), duet=bool(r['duet_file']), catalog='billboard', multi=bool(r['multi_artist']))
for db in ('singking', 'karafun'):
    c = sqlite3.connect(f'file:{src}{db}_catalog.sqlite?mode=ro', uri=True)
    q = f"""select k.track_id, k.artist, k.title, a.tessitura, n.app_tessitura, n.audio_octave_move, s.mostly_rap, n.is_duet, s.multi_artist
            from note_ranges n join {db}_songs k using(sk_song_key) join app_ranges a on a.track_id = k.track_id
            join songs s on s.track_id = k.track_id where n.audio_octave_move is not null"""
    for tid, artist, title, rec, note, move, rap, duet, multi in c.execute(q):
        if tid not in rows:
            rows[tid] = dict(artist=artist, title=title, recording=rec, noteAsStored=note - move,
                             rap=bool(rap), duet=bool(duet), catalog=db, multi=bool(multi))

def nearest(note, rec):
    s = 0
    while note + s - rec >= 6: s -= 12
    while note + s - rec < -6: s += 12
    return s

moves = Counter(nearest(v['noteAsStored'], v['recording']) for v in rows.values())
off = sum(n for m, n in moves.items() if m)
print(f'{len(rows)} songs with both; note-file octave disagrees with the recording in {off} ({off / len(rows):.1%}); moves {dict(moves)}')
json.dump(list(rows.values()), open(out, 'w'))
