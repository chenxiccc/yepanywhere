# Pre-existing failing test: MessageList search finds two compact summaries

`packages/client/src/components/__tests__/MessageList.search.test.tsx:275`
fails with testing-library `getMultipleElementsFoundError`:
`screen.getByText("system compacted needle context")` matches more than one
element.

Pre-existing relative to the `useVersion` retained-snapshot work that surfaced
it — verified by pathspec-stashing that change and re-running the file at
`4859626a`: 7 passed / 1 failed either way.

Likely cause: `913232cf` ("Make compact chips expandable; classify live compact
summaries") made a compact chip render its summary in both the collapsed chip
and the expandable outline, so the fixture's summary text now appears twice.
Whether that is a rendering defect or just an under-specified query needs a
look at the chip markup: if the outline is meant to duplicate the summary,
narrow the query (scope to a container, or `getAllByText`); if not, the chip
should render the summary once.

Out of scope for the client query controller work that surfaced it.
