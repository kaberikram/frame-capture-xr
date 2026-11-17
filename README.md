# Frame capture

On a Meta Quest 3 you pinch a rectangle in the air. While you hold it, the world inside the rectangle falls behind time, and everything outside stays live. Letting go leaves the frame where you made it, photographs that view, and eases the photo forward into a depth relief. Draw another frame and the earlier ones stay put.

There are two pages. `/` is this, frame capture. `/peel` is the room peel: pinch a wall or a table and pull, and that piece of your room comes away in your fingers. See [Peel the room](#peel-the-room).

Ideas for the live room mesh (time-warped surfaces, frozen 3D snapshots, ghost replays, and more) are in [docs/IDEAS.md](docs/IDEAS.md).

The desk preview does the same thing without a headset: the mouse draws the frame, and a stand-in room (or a webcam) stands in for the passthrough camera.

## Run

```
npm install
npm run dev
```

The dev server is HTTPS on port 4473, which the Quest browser needs for WebXR. Open the URL it prints. `/peel` is the room peel. `/clean` and `/peel/clean` are the same sessions without the guide, the captions, or the status prompts. All of these are rewrites of the same page, so a refresh stays there. On a host without the rewrites, `?mode=peel` opens the room peel.

On the headset, use the same network, accept the certificate warning, and press **Enter passthrough**. The first time, the page asks for the headset cameras before it goes in, because Quest Browser can lose that prompt once passthrough is running. Allow it, and allow hand tracking when asked. You do not need Space Setup. The session is seated. Hands only; controllers are not used.

If the camera cannot start, the launch card and the frame say why: blocked (allow headset cameras for the site in the browser's site permissions, and for Browser in the headset's app permissions, then reload), not found (photos need a Quest 3 or 3S with current software), or busy (another tab or app has it). Only one site can use the headset cameras at a time.

On `/peel`, `?debug=1` also shows whether depth is arriving (mode, readings per pass), how much room has been built, and whether each hand's torch is landing on it; an error while stepping the room shows as a caption. `?debug=1` adds a small panel with the frame rate, the worst frame, long main-thread tasks, the camera (asking, starting, active, or error), the hands, and how long each step of the last capture took. `?sound=0` keeps it silent. Your real hands show through passthrough, so IWSDK's hand models are hidden; `?hands=1` draws them, tracking every finger.

Without a headset, open `https://localhost:4473/?preview=1`. Drag with the left button to draw. Right-drag (or alt-drag) looks around. Keys `1`–`4` set the time inside the frame (echo, slit, ripple, live) and `t` cycles them. `https://localhost:4473/peel?preview=1` is the room peel with the mouse. `?cam=1` uses a webcam for the photo instead of the stand-in room. `?shot=1` plays the draw, the relief, the peel, the frame dissolving, and the sticker landing on the back wall. `?at=curl` holds the curl, `?at=detached` holds the sticker floating, and `?at=stuck` holds it on the wall. `?at=rest`, `?at=peel` and `?at=open` still hold the depth-sheet fan. `?ui=0` hides the card. The stand-in wall, side wall, and table are surfaces the sticker can stick to. `?warp=ripple` starts in a chosen mode. `prefers-reduced-motion` starts on live unless the URL asks otherwise.

## First headset run

Open the page with `?debug=1` the first time.

1. **Enter passthrough.** The panel should show about 72 or 90 fps. The console has a `[frame] session` line listing the granted features, and `[frame] camera` lines once the camera runs.
2. **Wait for depth.** The first visit downloads the depth model (about 25 MB) in the background. Until it is ready, frames use brightness depth.
3. **Draw a frame with one hand and look through it.** The room inside should echo. Turn the other palm toward you and a small stack of tiles appears on the thumb side: Echo, Slit scan, Ripple, Live. Bring a fingertip close and a thin line joins it to a tile; touch the tile and that mode drops into the frame. A quick flick of an open hand through the glass cycles the time modes. Pinch both rims and pull, and the pattern stretches with your hands. It always runs at full strength.
4. **Let go of the frame, and let your hand fall.** The photo is whatever the window was showing, so an echo can still hold a hand that has since moved away. Live mode takes the ordinary camera photo. The `[frame] capture` line gives the picture and darkroom times, and `[frame] depth model in … ms` how long the model took.
5. **Check the photo lines up with the room.** Look at the edge of the captured frame against the real room behind it. If the photo sits a little off, trim the lens with the URL fields under Tuning.
6. **Peel a corner, pull past the mark, and touch the sticker to a wall.** The time window steps aside and the print peels. It should land flat with a soft thup.

Then open `/peel?debug=1` for the room peel, which has not yet been run on a real headset:

1. **Enter passthrough and look around slowly for a few seconds.** The console's `[frame] session` line should list `depth-sensing`. If it does not, or the caption says the browser cannot read the shape of the room, the peel cannot work in that browser.
2. **Bring a fingertip toward a wall or table.** Light should gather on the surface, not in the air in front of it or behind it. If it sits off the surface, the depth is being placed wrongly.
3. **Pinch and pull slowly.** Check the picture on the piece is that part of the wall, lined up with it at the start, and that your hand is not printed on it.
4. **Watch the frame rate.** Depth fusion runs every frame on this page. If the panel drops well below 72 fps, note it.

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
| A short stack of frosted tiles on an upturned palm | Echo, Slit scan, Ripple, and Live. A thin line follows your fingertip; a touch chooses that tile |
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

Each one always uses the whole ring. The other modes carry a light warm grade so the window reads as the same sunlit world, a moment removed. On a headset, turn one palm toward you. A short stack of frosted tiles floats just off the thumb side of the palm and fades in over about a sixth of a second. As the other index finger approaches a tile, a thin white line joins the tile's edge to the fingertip and the tile turns from translucent tan to solid beige. Touch it and the tile presses in, then a copy of it travels into the frame and that mode lands. Turn the palm away and the stack scales away. Pulling two pinches apart on the rim stretches the pattern in the glass; it eases back when you let go. A flick through the pane cycles the time modes. On the desk, `1`–`4` and `t`. The glass is there while the frame is. During the bloom the print has the frame to itself. Once it has settled, the window returns and the print steps aside, until you peel, fan the sheets, or take the sticker. A flat demo photo (`?at=photo`) is never covered.

An echo photo can include a hand that was in the pane a moment ago, even after the shutter waited for your hands to leave. Switch to live for a picture of the room as it is.

## Peel the room

`/peel` is its own page. Nothing is drawn on the room, and nothing is written in the air, until you mean to take something. It needs no room scan: the headset's live depth builds the room as you look around (see How it works).

**Your hand is a torch.** Hold an open hand up and point, near or far. Where it points, the very piece of the room a pinch would take shows itself: a ghost of the depth mesh in its real shape, with a grid of light on it and a warm line round its edge. Nothing else is drawn. This is real-time depth; nothing comes from a room scan.

- **A thing standing on a table or shelf** (a stack of CDs, a cup, a box): it is fitted as a clean solid, a box, a round or a smooth outline, with straight walls down to the table and a flat or gently shaped top. The grid follows its own edges, square to its sides. The fit holds still while you reach; it only moves if the thing really does.
- **Any other whole thing** (a ball, a vase, a bag): the grid wraps the depth mesh of the thing itself, without the table it stands on.
- **Part of something bigger** (a wall, a table, a sofa): a rounded square of it, about 24 to 30 cm across, shown only when your fingertip is within about 30 cm of it. From further off the torch lights whole things only, so pointing at a thing and overshooting does not light the wall behind it. It sits level as you see it.

The ghost is worked out a few times a second from what depth has built, and holds still in between. It dims behind your hand but still shows through, so the thing you are reaching for stays marked. Once a whole thing shows its ghost, it stays on offer while your fingertip is within about 12 cm of it, wherever the finger points, and for a little over half a second after the fingers start to close: reach in and pinch, and that thing is what you get. Either hand works; it follows the hand whose torch falls nearer. `?mesh=all` also shows the whole room's live mesh, and `?motes=0` hides the motes of light that settle where depth is read.

**What is shown is what a pinch takes:** exactly that piece of mesh.

**Pinch and pull.** A copy of that piece of mesh slides out, wearing the camera's picture of it, taken before your hand got in the way. Pinched from across the room, about 9 cm of pull and it comes away and floats over to your hand. Let go sooner and it sinks back. The ghost stays on the real thing for a second or so, then goes. Nothing is left on your room.

**Carry it, let it go, set it down.** It trails your hand and leans into the movement. Let go in open air and it floats, drifting on a little if you were moving. Let go over a table or the floor and it is set down there. Look at a floating piece and pinch to call it back to your hand, or pinch it directly.

Only the side of a thing that the headset has seen comes away. Its far side is open, and from behind the picture glows through like a paper lantern. A fitted solid is closed all round, but its far walls were never in a camera picture, so they show the warm film instead of a photo.

With `?debug=1` the `stand` line shows the fitted shape and its size, how well it fits, how much table was seen round it, and why there is no fit when there is none. `?standfar=` changes how much a side the eye cannot see is pulled in (default 0.3 of a voxel), for tuning on the headset.

`?flat=1` brings back the older flat peel for bare surfaces: a torn outline shows first, and a flat piece about 22 cm across peels off, leaving warm light that fades.

Twelve pieces is the limit. The oldest then fades. The page shows no hints. It does not draw frames, has no time window or palm menu, and does not download the depth model.

### How it works

On a Quest the page asks for WebXR depth sensing, which frame capture does not. The headset works out depth live from its own cameras; it does not need Meta's Space Setup scan of the room. The page does not ask for plane detection, mesh detection or hit-test (which come from that scan and which only frame capture uses), so it works in a room that was never scanned. Quest Browser still asks to allow spatial data, because depth counts as spatial data. The browser's own Enter button gets the same session as the page's. Depth readings are fused on the CPU, in small batches, into a sparse distance field: about 4 cm to a voxel, a few metres out. Quest Browser is WebGL, so there are no compute shaders to do it on. The field is never shown. Every lookup marches the field (`RoomField.surfaceAlong`, `near`), which costs the same however much of the room has been read.

The piece is a 25 by 25 grid laid on the surface around the pinch, with the height of the real surface at each point. Its picture comes from the passthrough camera. The page keeps the last six camera frames, about two seconds, each with the lens pose that took it. When you pinch, your hand is in front of the spot, so the picture is taken while the outline or ghost is showing, before the hand gets there: the newest frame in which no hand joint was over the spot. Each point is projected through that frame's lens to find its place in the image. A piece that comes away with no frame that saw its spot keeps asking for one for three seconds; until then it is a warm film. Camera pictures are toned down a little, because the headset camera exposes a dim room brighter than passthrough shows it.

The place a piece left is carved out of the field, so new depth does not paint the wall back in behind the light. When the light has gone, about two seconds later, the field there is allowed to fill in again.

The live mesh on show is built from the coarse field with surface nets, chunk by chunk: each frame the chunks whose surface has really moved are meshed again, nearest your attention first, until 3 ms are spent (`RoomField.netStale`, `src/room/live-mesh.ts`). Chunks read one voxel into their neighbours, and a change at a chunk's face marks the neighbour too, so they join without gaps. Each depth pass reads 40 by 30 places. A reading is spread along the surface it lies on (worked out from its neighbours in the depth image), and further for far readings, so the skin has no holes and a table seen at a shallow angle stays flat.

A second, finer field (2 cm to a voxel) is kept only around whatever has your attention: what a fingertip is nearing, or what you are looking at with a hand raised. Every other depth pass reads an 84 by 60 cm window there instead of the whole view. A pass starts every tenth of a second. `?fine=0` turns it off.

A thing standing on a level surface is fitted in `src/room/stand.ts`, from the fine field, a few times a second. Each column of the field is followed down to the first surface, which gives a height map. The surface the thing stands on is the nearest level below the pinch that really surrounds it (most of a ring just outside the thing must be at that level, so a book beside it is not taken for the table). The cells standing more than about a centimetre above it make the thing's footprint, cleaned and with holes filled, and its outline is traced on a 1 cm grid. A box (the tightest turned rectangle), a circle and a smooth outline are tried, and each side is then put where the field shows the thing's wall, or, for a side the eye cannot see, where the height map drops. The top is flat if it is nearly level, or a smoothed height map. Things that narrow toward the bottom or the top (balls, vases), things open at the top (a pot), things with nothing under their top (a stool), and pinches above the thing are left to the depth mesh below. Each new fit is compared with the one on show: a change smaller than a few millimetres or degrees is ignored, a larger one is eased toward, and a different shape has to be found twice in a row. When nothing has moved the very same mesh is kept, so the ghost is not rebuilt at all. The fit takes about a millisecond.

Depth is also fused more cleanly than before. Each voxel keeps a true running average of its last two dozen readings. At a depth step (the edge of a box against the table behind it) a reading is not spread sideways or written far behind itself, so the field does not grow a skirt into the shadow behind the thing; a reading half-way across a step, which is blur between the two, is dropped.

Each reading also clears the space it looked through. Where the field still holds something solid along the way, up to 1.5 m out, the reading counts against it as open air, so a hand or an arm that slipped past the hand mask, or a thing that has been moved, is gone after a few looks. A reading well behind the one next to it (a ray that skimmed past the edge of a nearer thing, or one that read too far) clears nothing, so the corners of a thing are not worn away. The fine field also holds on to what is within 35 cm of what has your attention: a hand reaching for a thing hides it from depth, and would otherwise let it be the first thing forgotten.

A torch that lands on the coarse field (4 cm voxels) is moved onto the fine field's surface before the fit, along the way the surface faces or the line of sight. Before, a hand close to a thing often had its torch on the coarse surface a few centimetres off the real one, and no fit was tried at all (`stand none coarse` on the debug panel). A fit also needs only 30% of the table seen just outside its outline, down from 45%: seen from in front, a thing hides the table behind it, and a real stack of CDs came out at 0.46 to 0.47, fitting one look and not the next.

Anything else is cut out of the field in `src/room/object.ts`. The fine field only covers a small window, and a wall seen through one can look like a closed shape; so when the coarse field, which sees the whole view, finds that the surface runs on past arm's reach, it is taken as part of something big (`pickShell`). Starting at the pinch, it follows the surface outward, leaving out the level surface the thing stands on, and stops at 42 cm. If the surface ends before that, it is one thing. If it runs on, a 19 cm round piece is taken. The result is a smooth mesh (one vertex per voxel cube the surface crosses), and each vertex finds its place in a camera frame the same way a flat piece does. Depth readings within 5.5 cm of any joint of either hand, or of a few points down each forearm, are left out of the fields, so your hand never becomes part of the room. So are readings that sit part way between a near thing and what is behind it.

What has your attention is found once a frame: where a hand's torch falls (a ray from the fingertip, along the way the hand points steadied by the line from your eye through the fingertip, up to 3 m), or what you look at with an open hand raised. Its shell is worked out a few times a second. A whole thing shows its ghost (`ghostMaterial`); anything else shows the cut (`cutoutMaterial`). Both are drawn with real opacity: faint added light, the way the old glow was drawn, all but vanishes over passthrough in a dim room.

Going into or out of the headset clears both fields, so the desk's stand-in room is never left standing in your real one.

Browsers hand depth over in one of two ways, and the page reads both. Some give numbers (`cpu-optimized`). Quest Browser gives a texture (`gpu-optimized`), so the page draws a 28×20 grid of readings from it into a tiny target and reads that back a few frames later (`src/room/gpu-depth.ts`). The console's `[frame] room depth is …` line says which one the session got. `?depth=gpu` asks for the texture first, which is how the emulator checks that path.

If the browser has no depth sensing, the page says so in one line and nothing can be peeled.

On the desk, `/peel?preview=1` reads the stand-in room with rays instead of a depth camera. The cursor is both the look and the fingertip: the vase, the cup on its stand, or the stack of CDs on the low table under it shows its ghost (the cup is fitted as a round, the CDs as a box), and a bare wall or the table shows the outline of the cut. Press a thing or a surface and drag up to pull it toward you. A free piece rides just above whatever the cursor is over, and lands there when you let go.

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
| `room/` | the room peel: the sparse distance field, the short memory of camera frames, and the piece that comes away |
| `interaction/` | what is held (`Grip`), the router, stickers (curl, detach, stick, unstick), depth sheets, the frame handle, stretch, flick, and the palm menu |
| `look/` | relief shader, the time-window glass, the palm menu, the room piece and the light behind it, bloom spring, frame border, dissolve |
| `world/` | surfaces from the room scan, the landing outline, the stand-in room |
| `sound/` | the synthesized soundscape and the cues that trigger it |
| `desk/`, `ui/`, `debug/` | desk camera and scripted demo, status line, `__capture` and the `?debug=1` panel |

## Checks

- `npm test` runs the pure-math tests: crop, peel, stick, hand filtering and release, hands-in-frame, separable depth filters (checked against the old brute-force ones), the bloom spring, the time-window modes, the stretch, flick, and palm-menu math, and the room field.
- `npm run typecheck` and `npm run build` compile the app.
- `npm run smoke` drives the desk demo and an emulated headset in headless Chromium. The headset part uses the IWER emulator the dev server injects: it pinch-drags a frame and checks it is captured and blooms, then leaves a hand in the frame and checks the shutter waits. On `/peel` it pulls a piece off the stand-in room with the mouse (settle back, grow, pop, land on the table, float), then lifts the vase out whole and sets it on the table. In the emulated headset, once with each kind of depth, it reaches for a surface, pinches it and pulls it free, then holds a hand up, checks its torch lights a circle of mesh across the room and that a pinch takes the lit piece, and turns the head looking for a thing whose ghost shows, to pinch it from across the room. The emulated room is a rough scan, mostly big furniture, so a run sometimes finds no thing; it then prints `skip` for that part instead of passing it. The emulator's room is served from the installed `@iwer/sem` package, so the run needs no network. `SMOKE_CHROMIUM=/path/to/chrome` uses a browser that is already installed. `-- --shots out/` also saves a screenshot of every `?at=` stage. It needs Playwright: `npm i -D playwright && npx playwright install chromium`.
- `npm run check` runs typecheck, tests, and build.
