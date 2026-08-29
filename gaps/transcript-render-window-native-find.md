# Transcript render window hides rows from native browser Find

Long loaded transcripts activate `useTranscriptRenderWindow`, which unmounts
rows outside the viewport and replaces them with height spacers. Native browser
Find can search only mounted DOM, so it cannot find text in an off-window loaded
row even though YA's semantic transcript model still contains that row.

The performance gain from windowing is accepted, and the missing native Find
behavior is not a release blocker. YA's in-session search remains required and
must continue to wake and align off-window matches. Before fixing this gap,
choose a browser-compatible contract: preserve native Find without restoring
unbounded DOM, or provide an explicitly approved equivalent while retaining the
bounded render window. Add browser-level coverage for an off-window match.

Found 2026-08-29 while harsh-reviewing the measured-height transcript render
window after its performance acceptance.
