# Cancelling streaming-speech startup can report a connection failure

Rapidly toggle the microphone on and then off with Grok server-routed STT,
before the first response arrives. The UI can show **Speech streaming
connection failed** even though the user intentionally cancelled startup. An
intentional pre-response stop should return speech capture to idle without an
error.

The exact message originates in
`packages/client/src/lib/speechProviders/YaServerProvider.ts` at the streaming
socket `onerror` handler. The provider's ordinary `stop()` branch for
`starting` increments `startToken` before closing media and the socket, so the
simple same-provider cancellation path appears intended to ignore the racing
error already. The report may depend on which startup phase the second click
crosses, relay-socket timing, or a provider/state replacement. Do not broadly
suppress socket errors: real connection failures still need to surface.

This was not fixed alongside the waveform presentation work because a faithful
reproduction needs a controlled microphone plus streaming socket, or a trace
from the reported Grok path. Add a provider test that cancels separately while
the mic, socket, and first audio frame are pending, and assert idle state with
no `onError`; use the failing phase to repair ownership of intentional cancel.
The speech lifecycle contract is in
[`topics/mic-button-speech-ui.md`](../topics/mic-button-speech-ui.md).

Found 2026-08-11 while adding waveform background-opacity controls.
