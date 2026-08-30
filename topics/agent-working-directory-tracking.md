# Agent Working Directory Tracking

> YA tracks the effective project/working directory for a session separately
> from the provider transcript location, so UI state can follow the project an
> agent is actually discussing even when the transcript was born elsewhere.

Topic: `agent-working-directory-tracking`

## Contract

Agents generally keep their shell cwd at the project root, and in conversation
they should communicate paths as if the project root is the working directory.
YA uses the session's effective project for UI routing, relative file links,
and file-viewer access.

A session can still start under the wrong provider project. Reclassification is
a YA-only metadata change: it changes the effective project/working directory
without sending a user, assistant, or system turn to the provider transcript.
The provider transcript may remain stored under its original project; YA must
therefore track both:

- effective project: the project used for UI links, project breadcrumbs, and
  relative-path interpretation
- transcript project: the provider-native location used to read the session
  log

Existing-session moves and launches resolve these facts from durable metadata
and exact provider-native evidence. For Codex, `session_meta.cwd` is the
transcript project even when the request URL or a live process names another
project. A durable working-project selection supplies the resumed cwd;
otherwise YA resumes and reactivates from the native transcript project. The
request URL and a process launch project are never transcript-location
evidence for a provider whose session records that location intrinsically.

## Project Switches

Changing the project from the session header records that the agent has moved
work to another project. This should be treated as working-directory tracking,
not as transcript editing. It is especially useful when a session was launched
from the wrong directory and the agent later `cd`'d to the project that the
conversation is actually about.

## Relative Links

Open question: previous-turn relative path links may need special treatment
after a project switch. The intended behavior for now is to render relative
links against the current effective project, because the reclassification is
usually correcting the working directory for the whole visible conversation.

If YA ever persists rendered HTML or file-link anchors as source of truth,
project reclassification must invalidate or regenerate those rendered links so
old anchors do not keep pointing at the transcript project. If exact
fixed-font spans cannot be recovered, it is acceptable to link other filename
instances in the same assistant turn, but public shares must not expose
private project file-viewer links.
