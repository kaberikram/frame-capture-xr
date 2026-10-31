# Frame capture

On a Meta Quest 3 you pinch a rectangle in the air. Letting go leaves it where you made it, photographs the passthrough inside it, and eases that photo forward into a depth relief. Draw another frame and the earlier ones stay put.

The desk preview does the same thing without a headset: the mouse draws the frame, and a stand-in room (or a webcam) stands in for the passthrough camera.

## Run

```
npm install
npm run dev
```

The dev server is HTTPS on port 4473, which the Quest browser needs for WebXR. Open the URL it prints.

On the headset, use the same network, accept the certificate warning, and allow the camera and hand tracking when asked. You do not need Space Setup. Press **Enter passthrough**. The session is seated. Hands only; controllers are not used.

Without a headset, open `https://localhost:4473/?preview=1`. Drag with the left button to draw. Right-drag (or alt-drag) looks around. `?cam=1` uses a webcam for the photo instead of the stand-in room. `?shot=1` plays the draw, the relief, then peels the photo off a corner until it comes free. `?at=curl` holds the curl, and `?at=detached` holds the sticker floating in front of the empty frame. `?at=rest`, `?at=peel` and `?at=open` still hold the depth-sheet fan. `?ui=0` hides the card.

## Gestures

A frame is whatever size and shape you drag. It is not snapped to a wall. It sits on a plane that faces you and stays level with the floor.

- One hand: pinch and drag. The first pinch is one corner. The other corner follows your hand.
- Both hands: pinch with each hand. The two pinch points are opposite corners.
- Let go, and if both sides are at least 12 cm the frame is anchored in the world and the photo is taken. A smaller drag is dropped.
- After a two-hand frame, open both hands before starting another, so the hand that is still pinching does not immediately draw again.
- On the desk, the left mouse button is the pinch. Drag a corner of a finished frame to peel it. Shift-drag fans the depth sheets.

Once the photo has eased into a relief, pinch within about 6 cm of a corner and pull. The photo curls off the frame like a vinyl sticker: a soft cylinder bend along a fold perpendicular to the pull, with the depth relief still on the sheet and a shadow on the part that is still stuck. Let go before it is about 70% peeled and it springs flat. Pull past that and it comes free, a slightly curved sticker in your hand. Let go and it stays where you left it. Pinch it again to move it. The white frame stays put, and the live room shows through it. Pinch with both hands (or shift-drag on the desk) and the older depth-sheet fan opens instead: near things on the front sheets, the far wall on the back, gaps empty. The white handle under the frame moves and tilts the frame. It stays where you leave it.

Hands are not cut out of the photo. Move them outside the rectangle before you let go.

The photo is the camera frame cropped to the rectangle, reprojected with the Quest 3 lens. In the desk preview the same crop uses the view camera.

Depth Anything V2 (small) estimates depth in a worker. If it has not answered in about a second and a half, brightness stands in and the model replaces it when it arrives. On the painted stand-in the brightness relief is the cleaner of the two, because the model reads that flat picture as a wavy surface. On a real room, the model is the one to trust. The relief is a subdivided mesh pushed forward by depth, textured with the photo. Steep depth jumps sit back on the far side and fade out, so a cliff does not stretch into a sheet. The pop eases over about a second. `prefers-reduced-motion` skips the ease.

## Tuning

The **Capture settings** entity in the scene carries `CaptureLook`. The same fields are the knobs:

| Field | Default | What it does |
| --- | --- | --- |
| relief | 0.42 | How far the nearest pixels come forward, as a share of the frame’s long side |
| pop | 0.85 | Seconds the relief takes to ease out |
| edge | 0.18 | Depth jump (0–1) where a silhouette starts to fade. Lower culls more |
| band | 0.1 | Width of that fade |
| feather | 0.018 | Soft inset where the photo meets the white frame |
| minSpan | 0.12 | Smallest side, in metres, that is kept |
| strip | 0.008 | Thickness of the white frame, in metres |
| segments | 72 | Subdivisions along the long side |
| layers | 24 | Depth sheets a two-hand pull splits the photo into |
| spread | 0.2 | How far the front sheet comes toward you, in metres, at a full two-hand pull |
| curl | 0.075 | Bend radius of the sticker peel, in metres. Larger is softer |
| detach | 0.7 | Peel amount where the sticker lets go of the frame |
| spring | 36 | How hard a sticker that has not detached snaps back |

The Quest 3 lens is rectilinear, 863 px at 1280 wide, mounted about 6.5 cm in front of the eye and tilted 11.8° down. A headset check can trim it without a rebuild: `?lensf=863&yaw=-0.23&pitch=-11.77&roll=0.14&tau=0.025`. The console line `[frame] lens` shows which values came from the URL.

## Later modes

The relief shader samples the photo through one function, `frameContents(vec2 uv)`, in `src/relief.ts` (`PHOTO_CONTENTS`). `reliefMaterial(contentsFn)` injects a replacement. Slit-scan and slow motion belong there. They are not built yet.

## Checks

`npm test` crops a known quad. `npm run typecheck` and `npm run build` compile the app.
