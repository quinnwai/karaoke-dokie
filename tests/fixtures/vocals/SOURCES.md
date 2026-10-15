# Labeled sung-note fixtures

20 single sung notes for testing the pitch detector, MIDI 40 to 84 (E2 to C6).

- Format: WAV, mono, 16-bit PCM, 22050 Hz, first 1.5 s of each note.
- Name: `<NOTE>__<note_str>.wav`. NOTE is the labeled MIDI pitch as a note name with
  sharps, where MIDI 60 = C4. `note_str` is the NSynth id (`instrument-pitch-velocity`).
- The label is NSynth's nominal MIDI pitch from its metadata, not a measured f0.
- Sources: the NSynth test split has only two vocal instruments, `vocal_acoustic_000`
  (recorded voice, MIDI 50 to 70 only) and `vocal_synthetic_003`. There are no
  electronic vocals. Real voices were preferred wherever they exist at a pitch.

## Measured pitch vs label

"Median" and "p10 to p90" are the measured pitch relative to the label, in cents, from a
YIN f0 track every 50 ms over each file (single-frame octave slips of the estimator
dropped). Every file's spectrum has its fundamental at the labeled f0 and nothing at f/2
or f/3, so all labels are octave-correct.

- `vocal_acoustic_000` (real voice) sits within about 5 cents of its labels.
- `vocal_synthetic_003` is detuned sharp with a wobble: up to MIDI 75 its median is about
  +20 to +40 cents and frames reach about +80 cents; from MIDI 77 up it is within about
  10 cents. Use a tolerance of at least 50 cents on the median for these, or test
  them on nearest-note rounding of the median only.

| File | NSynth note_str | MIDI pitch | Note | Source | Velocity | Median (cents) | p10 to p90 (cents) |
|---|---|---|---|---|---|---|---|
| `E2__vocal_synthetic_003-040-127.wav` | `vocal_synthetic_003-040-127` | 40 | E2 | synthetic | 127 | +40 | +22 to +73 |
| `F#2__vocal_synthetic_003-042-127.wav` | `vocal_synthetic_003-042-127` | 42 | F#2 | synthetic | 127 | +40 | +22 to +73 |
| `A2__vocal_synthetic_003-045-050.wav` | `vocal_synthetic_003-045-050` | 45 | A2 | synthetic | 50 | +36 | +19 to +64 |
| `B2__vocal_synthetic_003-047-050.wav` | `vocal_synthetic_003-047-050` | 47 | B2 | synthetic | 50 | +39 | +21 to +68 |
| `C3__vocal_synthetic_003-048-127.wav` | `vocal_synthetic_003-048-127` | 48 | C3 | synthetic | 127 | +38 | +22 to +66 |
| `E3__vocal_acoustic_000-052-127.wav` | `vocal_acoustic_000-052-127` | 52 | E3 | acoustic | 127 | -2 | -8 to +0 |
| `F#3__vocal_acoustic_000-054-100.wav` | `vocal_acoustic_000-054-100` | 54 | F#3 | acoustic | 100 | -4 | -6 to -2 |
| `G#3__vocal_acoustic_000-056-025.wav` | `vocal_acoustic_000-056-025` | 56 | G#3 | acoustic | 25 | -2 | -4 to +3 |
| `B3__vocal_acoustic_000-059-100.wav` | `vocal_acoustic_000-059-100` | 59 | B3 | acoustic | 100 | +1 | -2 to +3 |
| `C4__vocal_acoustic_000-060-075.wav` | `vocal_acoustic_000-060-075` | 60 | C4 | acoustic | 75 | -1 | -5 to +3 |
| `D#4__vocal_synthetic_003-063-100.wav` | `vocal_synthetic_003-063-100` | 63 | D#4 | synthetic | 100 | +39 | +21 to +69 |
| `F4__vocal_acoustic_000-065-100.wav` | `vocal_acoustic_000-065-100` | 65 | F4 | acoustic | 100 | -0 | -6 to +4 |
| `G#4__vocal_synthetic_003-068-100.wav` | `vocal_synthetic_003-068-100` | 68 | G#4 | synthetic | 100 | +37 | +21 to +70 |
| `A#4__vocal_acoustic_000-070-075.wav` | `vocal_acoustic_000-070-075` | 70 | A#4 | acoustic | 75 | +3 | -3 to +7 |
| `C5__vocal_synthetic_003-072-050.wav` | `vocal_synthetic_003-072-050` | 72 | C5 | synthetic | 50 | +25 | +8 to +57 |
| `D#5__vocal_synthetic_003-075-127.wav` | `vocal_synthetic_003-075-127` | 75 | D#5 | synthetic | 127 | +31 | +22 to +74 |
| `F5__vocal_synthetic_003-077-025.wav` | `vocal_synthetic_003-077-025` | 77 | F5 | synthetic | 25 | +4 | -7 to +14 |
| `G5__vocal_synthetic_003-079-075.wav` | `vocal_synthetic_003-079-075` | 79 | G5 | synthetic | 75 | +12 | +2 to +47 |
| `A#5__vocal_synthetic_003-082-075.wav` | `vocal_synthetic_003-082-075` | 82 | A#5 | synthetic | 75 | +2 | -9 to +11 |
| `C6__vocal_synthetic_003-084-075.wav` | `vocal_synthetic_003-084-075` | 84 | C6 | synthetic | 75 | +2 | -8 to +11 |

## Dataset, citation and license

From the NSynth Dataset (test split, `nsynth-test.jsonwav.tar.gz`) by Google Magenta,
https://magenta.tensorflow.org/datasets/nsynth

Jesse Engel, Cinjon Resnick, Adam Roberts, Sander Dieleman, Douglas Eck, Karen Simonyan,
and Mohammad Norouzi. "Neural Audio Synthesis of Musical Notes with WaveNet Autoencoders."
2017. arXiv:1704.01279.

License: Creative Commons Attribution 4.0 International (CC BY 4.0),
https://creativecommons.org/licenses/by/4.0/

Changes from the originals: resampled from 16 kHz to 22.05 kHz with macOS `afconvert`
(highest-quality sample-rate converter) and trimmed to the first 1.5 s. No other edits.
