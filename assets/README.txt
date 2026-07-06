Rotulus image assets — drop files in this folder with these EXACT names.
The app works without them (CSS fallbacks paint instead), and each one is
picked up automatically the moment the file exists.

In this folder (assets/):

  bg-light.png              Full-page blob background, light mode.
                            Portrait, at least 1080x1920. The colorful 3D
                            blobs on lavender artwork.

  bg-dark.png               Same style for dark mode: glowing blobs on the
                            dark plum background (#151020). Portrait, at
                            least 1080x1920.

  header-illustration.png   The 3D phone + checkmark + heart + confetti art
                            that peeks out behind page titles. Around
                            800x800, TRANSPARENT background (important -
                            it sits on top of the page).

In assets/icons/ (future update — these replace the emoji placeholders
in the habit slot tiles once generated; ask Claude to wire them in):

  slot-wake.png             256x256, transparent background
  slot-morning.png          256x256, transparent background
  slot-afternoon.png        256x256, transparent background
  slot-evening.png          256x256, transparent background
  slot-bed.png              256x256, transparent background

Note: this folder is served with a 1-year browser cache. If you ever want
to REPLACE an image that's already live, give the new file a new name
(e.g. bg-light-2.png) and ask Claude to update the reference.
