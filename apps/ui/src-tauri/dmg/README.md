# DMG installer window styling

`tauri.conf.json` → `bundle.macOS.dmg` is the single owner of the macOS DMG
window look (background, window size, icon positions). All release channels
(stable / preview / publicdev) inherit it: the overlay configs define no
`bundle` section and Tauri deep-merges configs.

## Source of truth

- Design reference (window WITH icons, what it should look like):
  marketing uploads `5b92b9bd-dmg.png`.
- Background master (same art WITHOUT the app/Applications icons — this is what
  ships): `dmg-bg.png`, **4096x2728** export of 2026-09-21, kept with the
  marketing design assets. (The earlier 3072x2046 export is superseded.)

## Geometry

- Window: **840x560 points** (3:2, matching the art).
- `dmg-background.png`: **1680x1120 px @144 DPI** — exactly 2x the window, so
  Finder treats it as 840x560 points and renders it crisp on retina. Regenerate:

  ```bash
  sips -z 1120 1680 dmg-bg.png --out dmg-background.png
  sips -s dpiWidth 144 -s dpiHeight 144 dmg-background.png
  ```

  Note: Tauri's DMG `background` accepts png/jpg/gif only (no retina TIFF), so
  the 2x-PNG-with-DPI-metadata approach is the correct one.

- Icon centers (Finder `position` = icon center, from the design fractions
  ~34.5%/49% and ~65%/48.5% of the window):
  - app: `{290, 274}`
  - Applications: `{546, 272}`

## QR codes

The two QR codes baked into the background target **https://happier.dev/appstore**
and **https://happier.dev/playstore** (see the website `_redirects`). If those
URLs ever change, the background must be regenerated from a new design export.

## Hidden volume items

`.background`, `.fseventsd`, `.DS_Store` (and sometimes `.Trashes`) exist on
every styled DMG — `.background` holds this image, `.DS_Store` holds the icon
layout, `.fseventsd` is written by macOS on any writable volume. They are only
visible to users who enable "show hidden files"; every major app's DMG shows
the same. The preview script parks them off-window (`{2400, y}`). Tauri's
bundler positions only the app and Applications icons, so after the first real
bundle: check where Finder drops them for hidden-files-on users and, if needed,
add a post-bundle repositioning step to the release pipeline (it must run
BEFORE DMG signing/notarization).

## Icon labels

Finder renders the bundle and symlink names as icon labels. The current release
pipeline uses Tauri's stock DMG output, so `Happier.app` and `Applications`
remain visible at Finder's default text size.

Do not rename the Applications symlink to a visually blank Unicode character:
the filename is also its accessible label. Tauri's `DmgConfig` does not expose
label text size or symlink naming. Any future label or hidden-item layout change
therefore needs an implemented and validated post-bundle re-layout step before
DMG signing and notarization; this document must not describe that behavior as
shipped until the release pipeline owns it.

## Previewing without a build

See the session scratchpad `dmg-preview/` approach: create a staging folder with
a dummy `Happier.app` (real `icons/icon.icns`), an `/Applications` symlink and
`.background/background.png`, `hdiutil create -format UDRW`, mount, then apply
the geometry above with Finder AppleScript (icon view, no toolbar/statusbar,
icon size 100, bounds `{200, 120, 1040, 708}`).
