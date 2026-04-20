# Gmail Filter Extension

Chrome extension for managing Gmail labels and filters from a side panel.

## Status

Early development.

## Branching

- `main` is reserved for stable releases.
- `develop` is the active integration branch.

## Current Scope

- View current Gmail filters in one place
- Create and delete Gmail filters
- Create, rename, and delete Gmail labels
- Bulk-apply labels to existing messages
- Export and import filter and label configurations

## Local Setup

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer Mode.
3. Choose Load unpacked.
4. Select this folder.
5. Open Gmail in Chrome.
6. Open the extension side panel from the toolbar.

## Notes

This project currently uses Gmail DOM automation rather than the Gmail API, so Gmail UI changes may require selector updates.