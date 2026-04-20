# Gmail Filter Extension

Chrome extension for managing Gmail labels and filters from a side panel.

## Status

Early development.

## Branching

- `main` is reserved for stable releases.
- `develop` is the active integration branch.

## Development Workflow

1. Branch from `develop` for feature or fix work.
2. Open pull requests back into `develop` while the extension is still in active development.
3. Merge `develop` into `main` only when the current milestone is stable enough to publish.
4. Tag releases from `main` once that flow is in place.

## Pull Requests

Use small, reviewable pull requests with a clear scope.

- Base branch: `develop` for normal development work
- Base branch: `main` only for stabilization or release merges from `develop`
- Include a short testing note describing what was validated in Chrome and Gmail
- Call out any Gmail selector or DOM assumptions that may be brittle

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and pull request expectations.

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

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
