# Privacy Policy

Last updated: April 20, 2026

## Overview

Gmail Filter Manager is a Chrome extension that helps users manage Gmail filters and labels from a Chrome side panel.

## Data Handling

- The extension operates in the user's browser.
- The extension interacts with Gmail pages loaded at `https://mail.google.com/*`.
- The extension stores local working data such as drafts and snapshots by using Chrome extension storage.
- The extension does not send Gmail message contents, labels, filters, or account information to an external server operated by this project.

## Permissions Used

- `sidePanel`: used to display the extension user interface.
- `storage`: used to save local drafts and recent snapshots inside the browser.
- `tabs`: used to find the active Gmail tab and communicate with it.
- `downloads`: used when the user exports configuration data to a local JSON file.
- `https://mail.google.com/*`: used so the extension can interact with Gmail in the browser.

## Exported Data

When a user chooses to export configuration data, the extension generates a local JSON file containing filter and label information available to the extension in Gmail. That file is saved by the user through Chrome's download flow.

## Third-Party Services

This project does not provide a backend service for collecting or processing user data. Gmail itself remains subject to Google's own terms and privacy policies.

## Changes

This privacy policy may be updated as the extension changes. Material updates should be committed in the repository along with related product changes.

## Contact

Support and privacy-related questions can be submitted through the project's GitHub issue tracker:

https://github.com/cmechlin/gmail_filter_extension/issues