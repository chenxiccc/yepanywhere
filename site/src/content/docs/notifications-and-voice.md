---
title: Notifications and voice
description: Configure browser push notifications and choose browser, hosted, or local speech-to-text input.
---

Notifications keep a waiting agent from sitting idle. Voice input makes short
responses and longer instructions practical from a phone.

## Browser push notifications

Open **Settings → Notifications**, grant browser permission, and subscribe the
current browser profile. Yep Anywhere generates and stores its own VAPID keys
on the server.

The server decides which events deserve notification; the receiving browser
decides whether to show them based on focus and the visible session. A connected
tab is not automatically treated as visible.

If notifications do not arrive:

1. Check the browser's site permission and operating-system notification
   settings.
2. Confirm the current browser profile is subscribed.
3. Send a test notification from Settings.
4. Check that the service worker is active and the server has VAPID keys.

Native Android push is still in development. Browser Web Push remains the
published phone-notification path.

## Browser voice input

Browser-native recognition requires no server key when the browser supports
it. Open the microphone menu, choose the browser backend, and grant microphone
permission.

## Hosted speech backends

Server-mediated Deepgram and xAI transcription use dedicated server
environment keys:

```bash
export YEP_STT_DEEPGRAM_API_KEY="deepgram-..."
export YEP_STT_XAI_API_KEY="xai-..."
```

Speech keys are consumed by Yep Anywhere and stripped from child agent
environments. A dedicated STT key is preferred over a general provider key so
speech billing and agent billing stay separate.

## Local speech backends

Local Whisper, Parakeet, and NeMo are opt-in:

```bash
export YEP_VOICE_BACKENDS=ya-whisper,ya-parakeet
```

The first startup prepares the selected local environment and downloads its
model. NeMo is the heavier optional backend. A backend that fails setup or
validation is hidden and the server logs a repair hint rather than offering a
known-broken microphone choice.

Disable the entire voice surface with `VOICE_INPUT=false` when microphone input
is not appropriate for an installation.
