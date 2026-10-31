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

Without a headset, open `https://localhost:4473/?preview=1`. Drag with the left button to draw. Right-drag (or alt-drag) looks around. `?cam=1` uses a webcam for the photo instead of the stand-in room. `?shot=1` plays the draw, capture, and relief on its own. `?ui=0` hides the card.

## Gestures

A frame is whatever size and shape you drag. It is not snapped to a wall. It sits on a plane that faces you and stays level with the floor.

- One hand: pinch and drag. The first pinch is one corner. The other corner follows your hand.
- Both hands: pinch with each hand. The two pinch points are opposite corners.
- Let go, and if both sides are at least 12 cm the frame is anchored in the world and the photo is taken. A smaller drag is dropped.
- After a two-hand frame, open both hands before starting another, so the hand that is still pinching does not immediately draw again.
- On the desk, the left mouse button is the pinch.

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

The Quest 3 lens is rectilinear, 863 px at 1280 wide, mounted about 6.5 cm in front of the eye and tilted 11.8° down. A headset check can trim it without a rebuild: `?lensf=863&yaw=-0.23&pitch=-11.77&roll=0.14&tau=0.025`. The console line `[frame] lens` shows which values came from the URL.

## Later modes

The relief shader samples the photo through one function, `frameContents(vec2 uv)`, in `src/relief.ts` (`PHOTO_CONTENTS`). `reliefMaterial(contentsFn)` injects a replacement. Slit-scan and slow motion belong there. They are not built yet.

## Checks

`npm test` crops a known quad. `npm run typecheck` and `npm run build` compile the app.
