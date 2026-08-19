# Fonts

Self-hosted so the app makes no third-party requests. Both families are
licensed under the SIL Open Font License 1.1, which permits redistribution.

- **Fraunces** — https://github.com/googlefonts/fraunces (OFL 1.1)
- **Archivo** — https://github.com/Omnibus-Type/Archivo (OFL 1.1)

These are the `latin` subsets of the variable builds, taken from the Google
Fonts CDN. One file per family covers every weight in use.

Hebrew, Arabic, Cyrillic and other scripts are not in these subsets and fall
back to the system font, which is intentional: the display face is only used
for interface chrome, and shipping full multi-script files would cost far more
than it returns.
