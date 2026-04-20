# Contributing

## Branching

- Use `develop` as the base branch for normal feature and bug-fix work.
- Keep `main` reserved for stable merges from `develop`.

## Local Development

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer Mode.
3. Choose Load unpacked.
4. Select this repository folder.
5. Open Gmail in Chrome.
6. Open the extension side panel from the toolbar.

## Testing Expectations

Before opening a pull request, test the user flow you changed in a live Gmail tab.

- Confirm the extension still loads in Chrome.
- Validate the affected flow from the side panel.
- Re-test any Gmail settings dialog or menu touched by the change.
- Note Chrome version and Gmail context in the PR.

## Gmail DOM Changes

This extension currently depends on Gmail's web UI rather than the Gmail API.

- Keep selector changes narrow and intentional.
- Prefer resilient selectors based on accessible names or stable attributes when possible.
- Document any fragile assumptions in the pull request.
- If a selector is likely to drift, explain the fallback or failure mode.

## Pull Requests

- Keep pull requests small and focused.
- Target `develop` unless you are helping with a planned stabilization merge.
- Include a short summary, testing notes, and any Gmail DOM assumptions.
- Update documentation when behavior or setup changes.

## Issues

Use the GitHub issue templates for bug reports and feature requests so reports include enough detail to reproduce problems in Chrome and Gmail.