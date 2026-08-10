# Waveform disappears beneath opaque toolbar controls

The live microphone waveform is correctly elastic and contributes zero
required width in `useMessageInputToolbarLayout.ts`. When other controls use
the center interval, however, the signal can shrink away or become completely
obscured instead of remaining useful as a subtle background indication.

Explore painting the non-interactive waveform beneath the composer controls and
adding a user-controlled opacity for the control surfaces that obscure it. The
setting should affect background alpha without weakening icon/text contrast,
focus indicators, hit targets, or the Send and Mic priority contract. Verify
recording states in every theme at desktop and phone widths.

This is separate from the parked-file-viewer state and allocation work: it
needs an Appearance-setting contract, contrast decisions, and captures with
live waveform samples.

Found 2026-08-10 while fitting the parked file viewer into the composer gap.
