# Arc-style profile isolation: baseline experiment

This is a diagnostic, not an implementation of single-window multi-profile browsing.

## Baseline

- Fork: https://github.com/sykuang/zen-browser
- Upstream: `zen-browser/desktop`, `f2b18c4f6179a3918c0d92f2a7406322cda4ad12`.
- Firefox source: `158.0.1`.
- Local macOS arm64 full development build succeeded.

## Run

After the normal source download/bootstrap, use Node 22 and a Python with working `lzma`:

```sh
npm ci
npm run import
python3 scripts/update_en_US_packs.py
npm run build -- --jobs 4
npm test -- container_essentials/browser_container_extension_boundary.js --headless
```

On the initial setup, run `npm run init` to download/bootstrap the engine before the explicit language-pack update. Do not skip that language-pack step: otherwise missing Fluent strings can reject unrelated UI promises and fail an otherwise successful diagnostic.

## Observed result

The real browser-chrome run passed: **33 subtests, 0 failures, 0 todo**.

- Fresh containers A and B have separate same-origin cookies.
- Messages injected into the actual tabs report different sender `cookieStoreId` values.
- Both containers reach the same temporary extension background runtime (same nonce and sequential in-memory counter).
- B reads A's `storage.local` sentinel and overwrites it; A reads B's write.
- Cookies remain independent after those extension operations.

The harness creates a disposable browser profile. The test creates two fresh identities and unloads its temporary extension, closes its tabs, clears scoped cookies, and removes its identities during cleanup. It does not sign into a website or Mozilla account.

## What this does not prove

This test is **container-only**. It does not switch Zen workspaces or prove history, password, permission, sync, shortcut, or full-profile isolation. Passing it records the existing shared-extension boundary; it is not a green acceptance test for Arc-style profiles.

Source inspection identifies the architectural boundaries:

- `engine/toolkit/xre/nsXREDirProvider.cpp`: `SetProfile` asserts profile directories may only be set once.
- `engine/toolkit/components/extensions/ExtensionParent.sys.mjs`: `GlobalManager.extensionMap` is keyed by extension ID.
- `engine/toolkit/components/extensions/ExtensionStorageIDB.sys.mjs`: `getStoragePrincipal` uses the reserved `WEBEXT_STORAGE_USER_CONTEXT_ID`, not the tab's container.

A real implementation must isolate the relevant services and extension instances while providing one native window. Opening or hiding separate profile windows is not that implementation.
