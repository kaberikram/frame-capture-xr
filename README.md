# Frame capture

On a Meta Quest 3 you pinch a rectangle in the air. While you hold it, the world inside the rectangle falls behind time, and everything outside stays live. Letting go leaves the frame where you made it, photographs that view, and eases the photo forward into a depth relief. Draw another frame and the earlier ones stay put.

The desk preview does the same thing without a headset: the mouse draws the frame, and a stand-in room (or a webcam) stands in for the passthrough camera.

## Run

```
npm install
npm run dev
```

The dev server is HTTPS on port 4473, which the Quest browser needs for WebXR. Open the URL it prints. `/clean` is the same session without the guide, the captions, or the status prompts. It is a rewrite of the same page, so a refresh stays there.

On the headset, use the same network, accept the certificate warning, and press **Enter passthrough**. The first time, the page asks for the headset cameras before it goes in, because Quest Browser can lose that prompt once passthrough is running. Allow it, and allow hand tracking when asked. You do not need Space Setup. The session is seated. Hands only; controllers are not used.

If the camera cannot start, the launch card and the frame say why: blocked (allow headset cameras for the site in the browser's site permissions, and for Browser in the headset's app permissions, then reload), not found (photos need a Quest 3 or 3S with current software), or busy (another tab or app has it). Only one site can use the headset cameras at a time.

`?debug=1` adds a small panel with the frame rate, the worst frame, long main-thread tasks, the camera (asking, starting, active, or error), the hands, and how long each step of the last capture took. `?sound=0` keeps it silent. Your real hands show through passthrough, so IWSDK's hand models are hidden; `?hands=1` draws them, tracking every finger.

Without a headset, open `https://localhost:4473/?preview=1`. Drag with the left button to draw. Right-drag (or alt-drag) looks around. Keys `1`–`4` set the time inside the frame (echo, slit, ripple, live) and `t` cycles them. Key `5` (or `?warp=peel`) turns on Peel: the stand-in room is scanned into a faint mesh, and a click on that shimmer peels a patch off it. `?cam=1` uses a webcam for the photo instead of the stand-in room. `?shot=1` plays the draw, the relief, the peel, the frame dissolving, and the sticker landing on the back wall. `?at=curl` holds the curl, `?at=detached` holds the sticker floating, and `?at=stuck` holds it on the wall. `?at=rest`, `?at=peel` and `?at=open` still hold the depth-sheet fan. `?ui=0` hides the card. The stand-in wall, side wall, and table are surfaces the sticker can stick to. `?warp=ripple` starts in a chosen mode. `prefers-reduced-motion` starts on live unless the URL asks otherwise.

## First headset run

Open the page with `?debug=1` the first time.

1. **Enter passthrough.** The panel should show about 72 or 90 fps. The console has a `[frame] session` line listing the granted features, and `[frame] camera` lines once the camera runs.
2. **Wait for depth.** The first visit downloads the depth model (about 25 MB) in the background. Until it is ready, frames use brightness depth.
3. **Draw a frame with one hand and look through it.** The room inside should echo. Turn the other palm toward you and a small stack of tiles appears on the thumb side: Echo, Slit scan, Ripple, Live, Peel. Bring a fingertip close and a thin line joins it to a tile; touch the tile and that mode drops into the frame. A quick flick of an open hand through the glass cycles the time modes. Pinch both rims and pull, and the pattern stretches with your hands. It always runs at full strength.
4. **Let go of the frame, and let your hand fall.** The photo is whatever the window was showing, so an echo can still hold a hand that has since moved away. Live mode takes the ordinary camera photo. The `[frame] capture` line gives the picture and darkroom times, and `[frame] depth model in … ms` how long the model took.
5. **Check the photo lines up with the room.** Look at the edge of the captured frame against the real room behind it. If the photo sits a little off, trim the lens with the URL fields under Tuning.
6. **Peel a corner, pull past the mark, and touch the sticker to a wall.** The time window steps aside and the print peels. It should land flat with a soft thup.

If the panel's long-task count climbs while you capture, or the worst frame is above about 20 ms, note which step was running. Those numbers are what to tune next.

## Gestures

A frame is whatever size and shape you drag. It is not snapped to a wall. It sits on a plane that faces you and stays level with the floor.

- One hand: pinch and drag. The first pinch is one corner. The other corner follows your hand.
- Both hands: pinch with each hand. The two pinch points are opposite corners.
- Let go, and if both sides are at least 12 cm the frame is anchored in the world and the photo is taken. A smaller drag is dropped.
- After a two-hand frame, open both hands before starting another, so the hand that is still pinching does not immediately draw again.
- On the desk, the left mouse button is the pinch. Drag a corner of a finished frame to peel it. Shift-drag fans the depth sheets.
- With both hands pinching opposite rims of a finished frame, pull them apart or push them together. The time pattern stretches with your hands and eases back when you let go. It does not change how strong the effect is.
- Flick an open hand through the glass, quickly, and the mode cycles. A slow hand leaving after a photo does not.

Once the photo has eased into a relief, pinch within about 6 cm of a corner and pull. The photo curls off the frame like a vinyl sticker: a soft cylinder bend along a fold perpendicular to the pull, with the depth relief still on the sheet and a shadow on the part that is still stuck. The pull is measured from where your fingers pinched, toward you and toward the middle of the photo. The first 1.5 cm or so does nothing, like the tack of the glue. Then the peel follows your hand and gets firmer as it nears the mark, about 16 cm of pull. Past the mark the last bit holds and stretches a little, and at about 19 cm it pops free, a slightly curved sticker in your hand. Let go any time before the pop and it springs flat. `?peel=1.3` makes it take 30% more pull, `?peel=0.8` less. The empty white frame breaks into a few short pieces and fades, about 0.6 seconds, then it is gone.

Bring the sticker within about 4 cm of a wall, table, or other scanned surface and a faint outline shows where it will land. Let go, or touch the surface, and it flattens to the surface normal, squashes slightly, and settles with a soft contact shadow. The depth relief stays, and the corner you peeled sits a little off the wall. Let go in open space and it keeps floating. Pinch that lifted corner to peel it off and stick it somewhere else. Every sticker you leave stays for the session.

On a headset the surfaces come from plane detection and bounded mesh faces in the room scan, and from hit-test when those are missing. On the desk, drag a free sticker and move up to carry it away from you along the pointer; the back wall and the table are the demo surfaces. Pinch with both hands (or shift-drag on the desk) and the older depth-sheet fan opens instead: near things on the front sheets, the far wall on the back, gaps empty. The white handle under a frame that is still there moves and tilts it.

You do not need to move your hands out of the way. After you let go, the photo waits until no part of either hand, or the forearm behind it, is inside the frame. It then uses the first camera frame taken after that. If a hand stays in the frame for more than half a second, the status line asks you to let your hands fall away. After 1.2 seconds the photo is taken anyway.

Pinches are smoothed so tracking jitter does not shake a corner, and a fast drag still follows closely. The pinch is measured between your fingertip surfaces, so it suits any hand size. When you let go, the corner stays where your fingers were tightest, not where opening them dragged it.

The photo is the camera frame cropped to the rectangle, reprojected with the Quest 3 lens. In the desk preview the same crop uses the view camera. While a time mode other than live is on, the photo is a picture of the window instead, so the print keeps the lag, the trails, or the smear.

The photo is developed off the render thread. The shutter takes an image of just the frame's part of the camera view. A worker warps it into the photo and makes a brightness depth map, so taking a picture costs the headset no frames.

Depth Anything V2 (small) estimates depth in another worker. After about a second and a half, brightness depth shows as a gentle preview at about half height. When the model answers, its depth fades in over the preview and the relief blooms to full. If the model has not answered within 3.5 seconds, or cannot load, the brightness relief blooms to full instead, and a model answer that arrives later still fades in. On the painted stand-in the brightness relief is the cleaner of the two, because the model reads that flat picture as a wavy surface. On a real room, the model is the one to trust.

The relief is a subdivided mesh pushed forward by depth, textured with the photo. Steep depth jumps sit back on the far side and fade out, so a cliff does not stretch into a sheet. The relief blooms on a soft spring that overshoots by a few percent and settles in about a second. `prefers-reduced-motion` skips the motion.

## Look

The look is warm and soft, after the sunlit mood of Spike Jonze's *Her*: a cream line, a peach-to-coral glow, and warm dust. Every colour lives in `src/look/palette.ts`. `?look=neutral` switches to a white version to compare.

Each visual cue means something:

| What you see | What it means |
| --- | --- |
| A small warm light between thumb and index | Your fingers are about to meet. It blooms when the pinch registers |
| A line of light with a faint warm wash inside | The frame you are drawing |
| The world inside the frame is late, trailed, or smeared | The time window. Outside it, the room is live |
| A short stack of frosted tiles on an upturned palm | Echo, Slit scan, Ripple, Live, and Peel. A thin line follows your fingertip; a touch chooses that tile |
| The line inhales, brighter for a moment | The frame is anchored. If it keeps breathing, the photo is waiting for your hands to clear |
| The photo resolves out of a peach haze | It has been taken and is developing |
| A glossy band sweeping across | Depth is still on its way |
| A highlight running along the bend | The photo is peeling like vinyl |
| The frame lets go as drifting dust | The sticker came free |
| A soft outline that breathes on a surface | Let go here and it lands |
| A ring of light spreading on the surface | It landed |

A carried sticker trails your hand slightly and tilts with the motion. Let go in open air and it bobs gently where you left it.

In a headset, hints appear as a line of light text that drifts along a little below where you look, with no box behind it. Each shows once, when it helps: draw a frame, then the palm menu, then peel a corner, then bring it to a wall. The time hint steps aside after about eight seconds, or as soon as you change the mode. After about 45 seconds of nothing happening, the hint for that moment can show again. The launch card shows how far the depth model has downloaded. `/clean` leaves all of that off. A camera that cannot start can still say so.

If the headset camera cannot start, the glass says why, the same sentence as the launch card. Until the first frame arrives it says it is waiting. On the desk the stand-in room fills the window, so there is no camera message.

## Time window

The rectangle is a pane of glass over the live view. It keeps the last 16 camera frames on the GPU, each 320 px in a 1280² atlas (about 6.3 MB), with the lens matrix that posed it. A point on the pane is projected back through those matrices, so a still room stays put and only what moved is late. The desk paints its stand-in the same way, a few times a second. Nothing outside the pane is touched.

| Mode | What you see |
| --- | --- |
| Echo | Moving things leave a few ghosts. Still parts stay single |
| Slit scan | Each column is a different moment. The right edge is now; the left is the furthest back. A moving hand stretches |
| Ripple | Rings of different moments spread from the middle of the frame |
| Live | The camera now, with no warm grade. A photo from this mode is the ordinary full-resolution picture |

Each one always uses the whole ring. The other modes carry a light warm grade so the window reads as the same sunlit world, a moment removed. On a headset, turn one palm toward you. A short stack of frosted tiles floats just off the thumb side of the palm and fades in over about a sixth of a second. As the other index finger approaches a tile, a thin white line joins the tile's edge to the fingertip and the tile turns from translucent tan to solid beige. Touch it and the tile presses in, then a copy of it travels into the frame and that mode lands. Turn the palm away and the stack scales away. Pulling two pinches apart on the rim stretches the pattern in the glass; it eases back when you let go. A flick through the pane cycles the time modes. On the desk, `1`–`4` and `t`. `5` is Peel. The glass is there while the frame is. During the bloom the print has the frame to itself. Once it has settled, the window returns and the print steps aside, until you peel, fan the sheets, or take the sticker. A flat demo photo (`?at=photo`) is never covered.

An echo photo can include a hand that was in the pane a moment ago, even after the shutter waited for your hands to leave. Switch to live for a picture of the room as it is.

## Peel the room

Peel, on the palm stack and on key `5`, watches the real room. On a Quest it asks for WebXR depth sensing and fuses those depth frames into a sparse distance field, about 4 cm to a voxel and a few metres out. The mesh is only the surface, drawn as a faint warm wire with a slow scan, brighter where it was just filled in, so you can see where a peel will catch. It is not a solid model of the room. Quest Browser is WebGL, so the fusion runs on the CPU in small batches and the shader does the shimmer. A chunk can be copied out on its own; a later ghost replay can keep those copies and mesh them again.

Pinch a shimmering surface, or click one on the desk. The patch curls off the way a sticker does. The spot it left goes a little dark and stays empty, because new depth is not allowed to heal a place you have already peeled. Pull it free and let go on another reconstructed surface and the patch lies down on that shape. Let go in the air and it floats. The camera frame, when there is one, is what the patch shows. Without a camera it is a warm film of the surface colour. Frames, the time modes, and peeling a captured photo are unchanged. `/clean` has the same Peel tile and the same gesture, with no extra instructions. If the browser has no depth sensing, Peel says so in one line.

On the desk, `?warp=peel` scans the stand-in room with rays instead of a headset depth camera, so the same mesh and the same peel can be tried with the mouse.

## Sound

Hands-only input has no haptics, so small synthesized sounds stand in for touch. Each one comes from where it happens:

- a soft tick when your fingers meet
- a distant film-camera hush when the photo is taken
- two bell notes when the relief blooms
- a vinyl crackle that follows how fast you peel
- a gentle pop when the sticker comes free
- a low thup when it lands

Nothing is loaded from disk. Audio starts with the Enter button (or the first click on the desk), and `?sound=0` turns it off.

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
| snap | 0.04 | How close a held sticker must be to a surface, in metres, before it can stick |
| squish | 0.95 | Scale at the moment of contact. It eases back to 1 |
| dissolve | 0.6 | Seconds the empty frame takes to break apart and fade |

The Quest 3 lens is rectilinear, 863 px at 1280 wide, mounted about 6.5 cm in front of the eye and tilted 11.8° down. A headset check can trim it without a rebuild: `?lensf=863&yaw=-0.23&pitch=-11.77&roll=0.14&tau=0.025`. The console line `[frame] lens` shows which values came from the URL.

## How it is built

`src/app/capture-system.ts` wires the parts together and fixes the order they run in each frame. Each area has its own folder:

| Folder | What lives there |
| --- | --- |
| `app/` | the system, the shared context, the `CaptureLook` knobs, URL flags |
| `capture/` | camera rig and lens, the shutter (hands-clear wait), the time-window modes and the GPU ring, the darkroom and depth workers, crop, develop (depth stages and the bloom) |
| `input/` | hand pinches (filtering, release rewind) and the desk pointer. Both feed one router |
| `room/` | the sparse room field, the shimmer mesh, and peeling a patch off it |
| `interaction/` | what is held (`Grip`), the router, stickers (curl, detach, stick, unstick), depth sheets, the frame handle, stretch, flick, and the palm menu |
| `look/` | relief shader, the time-window glass, the palm menu, bloom spring, frame border, dissolve |
| `world/` | surfaces from the room scan, the landing outline, the stand-in room |
| `sound/` | the synthesized soundscape and the cues that trigger it |
| `desk/`, `ui/`, `debug/` | desk camera and scripted demo, status line, `__capture` and the `?debug=1` panel |

## Checks

- `npm test` runs the pure-math tests: crop, peel, stick, hand filtering and release, hands-in-frame, separable depth filters (checked against the old brute-force ones), the bloom spring, the time-window modes, the stretch, flick, and palm-menu math, and the room field.
- `npm run typecheck` and `npm run build` compile the app.
- `npm run smoke` drives the desk demo and an emulated headset in headless Chromium. The headset part uses the IWER emulator the dev server injects: it pinch-drags a frame and checks it is captured and blooms, then leaves a hand in the frame and checks the shutter waits. `-- --shots out/` also saves a screenshot of every `?at=` stage. It needs Playwright: `npm i -D playwright && npx playwright install chromium`.
- `npm run check` runs typecheck, tests, and build.
