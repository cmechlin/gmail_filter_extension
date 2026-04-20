# Release Checklist

Use this checklist when promoting work from `develop` into `main`.

## Before Merge

- Confirm `develop` is green and the working tree is clean.
- Review open bugs and known Gmail DOM breakpoints.
- Verify the release scope is stable enough for `main`.
- Confirm `README.md`, `CONTRIBUTING.md`, and store metadata still match the product.

## Validation

- Load the unpacked extension in Chrome.
- Test the side panel opens from the toolbar.
- Test label creation, rename, and deletion.
- Test filter listing and filter creation.
- Test bulk label application against a live Gmail search.
- Test import and export with a sample JSON file.
- Capture any Chrome or console errors before release.

## Versioning And Packaging

- Update `manifest.json` version.
- Regenerate extension package assets if needed.
- Verify `assets/icons` contains the expected icon sizes.
- Create the release zip in a local `releases/` folder if distributing manually.

## Branch And Git Steps

- Merge or fast-forward the intended `develop` commit into `main`.
- Push `main` to GitHub.
- Tag the release from `main` once the release is accepted.
- Push the tag.

## Store Readiness

- Review [docs/STORE_METADATA.md](docs/STORE_METADATA.md).
- Confirm screenshots and promo assets are current.
- Confirm privacy policy and support links are still valid before store submission.

## After Release

- Record follow-up bugs discovered during release testing.
- Return new work to `develop`.
