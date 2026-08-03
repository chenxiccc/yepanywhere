# Android Icon Artwork

Android 8 and later compose the launcher icon from the vector background,
foreground, and monochrome resources under `app/src/main/res`. The launcher
chooses the final circle, squircle, or other device mask.

`legacy-launcher-icon.svg` is the source for the density-specific launcher
PNGs used by Android 7 and 7.1, the only pre-adaptive Android versions allowed
by the app's minimum SDK. `play-store-icon.svg` is the full-bleed source for
the separate 512-pixel Google Play listing icon.

The generated PNG dimensions are:

| Artifact | Dimensions |
| --- | --- |
| `mipmap-mdpi/ic_launcher.png` | 48 x 48 |
| `mipmap-hdpi/ic_launcher.png` | 72 x 72 |
| `mipmap-xhdpi/ic_launcher.png` | 96 x 96 |
| `mipmap-xxhdpi/ic_launcher.png` | 144 x 144 |
| `mipmap-xxxhdpi/ic_launcher.png` | 192 x 192 |
| `artwork/play-store-icon.png` | 512 x 512 |

Keep the white Y geometry aligned across the SVG and Android vector sources.
Do not add a rounded rectangle, circle, bevel, border, or shadow to the
adaptive layers; Android owns that outer presentation.
