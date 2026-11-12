# Ideas: a live mesh of the room

A live depth mesh of the room opens up more than the peel. This note records the ideas, what already exists in the code, and what each one would need. Nothing here is built unless the "Now" column says so.

## Where things stand

| Idea | Status | Where |
| --- | --- | --- |
| Peel the room | Built on `/peel` | `src/room/peel-piece.ts`, `src/room/plates.ts` |
| Live mesh of the room | Built as a CPU distance field | `src/room/field.ts`, `src/room/room-scan.ts` |
| Ghost replays | Hook only | `RoomField.snapshot(key)` |
| Time-warped surfaces | Not built | `src/look/time-glass.ts`, `src/capture/time-history.ts` |
| Frozen 3D snapshots | Not built | — |
| Light, shadows, occlusion | Not built | — |

## Constraints

- **CPU fusion, not GPU.** Quest Browser runs WebGL, which has no compute shaders. Depth is fused into the field on the CPU in small batches each frame (`SAMPLE_BUDGET`, `EXTRACT_BUDGET`). Any GPU mesh would have to be built from that field, or from a fragment-shader pass over the depth image.
- **Sparse field.** About 4 cm to a voxel, a few metres out, and `MAX_CHUNKS` caps memory. Old chunks leave as the view moves.
- **Passthrough alignment.** Depth is in the headset's view. Anything drawn on the room has to line up with the real room through the camera lens (`src/capture/lens.ts`), which is trimmed by hand.
- **WebGL only.** No compute, no storage buffers, limited texture formats.

## 1. Time-warped surfaces

**What it is.** The echo trails and ripples stick to real walls and tables, so the room itself seems to wobble in time where you look.

**What exists.** The time glass is screen-space reprojection. It reprojects a point through the lens matrices of the last 16 frames (`src/look/time-glass.ts`, `src/capture/time-history.ts`). It does not know where walls are, so the effect floats on the glass.

**What it needs.** For each glass pixel, the world point it lands on. Ray-marching the field (`RoomField.surfaceAlong`) gives that. Then the time ring is sampled at the point's old screen position, not the glass's.

**Main risk.** A ray march per pixel is expensive in WebGL. A coarse grid of rays, interpolated, may be enough.

**First experiment.** Replace the glass's depth with the field's surface depth, sampled on a 32×32 grid, and check that a ripple bends around a table edge.

## 2. Peel the room

**What it is.** Pinch a patch of table or wall, the camera image peels off like a decal, and you stick it somewhere else.

**What exists.** Built on `/peel`. The piece grows as you pull, pops free, floats, lands and settles back. Its picture is a short memory of camera frames (`src/room/plates.ts`), not a mesh colour.

**What it needs.** Nothing new for the core loop. Open work: a better picture where a hand covered the spot (the memory picks an earlier frame, but there is no guarantee), and tuning on a real headset.

**Main risk.** Depth quality on a real room. Walls can read as curved or doubled.

**First experiment.** Run `/peel` on a Quest in a room with a table and a painting, and note where the piece lines up and where it does not.

## 3. Frozen 3D snapshots

**What it is.** A capture saves the mesh and its colours, so you can walk around a frozen moment of the room and leave it hanging there.

**What exists.** `RoomField.snapshot(key)` copies one chunk's field. The camera frame is available at capture time.

**What it needs.** Copy the chunks in view at capture time, keep their colours (from the camera frame, projected per vertex), and mesh them again from the copy. Chunks are small, so copies are cheap. Colour per vertex needs the lens projection at capture time.

**Main risk.** Memory. Sixteen frames of chunks plus colour could be large. Keep a budget and drop the oldest.

**First experiment.** Save one capture's chunks and colours, then re-mesh them with the room hidden and check they match.

## 4. Ghost replays

**What it is.** Record the mesh over time and play back a ghost of the room from ten seconds ago. Things that moved leave shimmering copies.

**What exists.** `RoomField.snapshot` and `takeRetired` are the hooks the code comments name. Nothing records over time.

**What it needs.** A timed ring of chunk snapshots, meshed on playback. Playback can reuse the extractor (`buildChunk`).

**Main risk.** Storage over ten seconds at a few chunk updates per second. Likely fine if chunks are copied only when they change.

**First experiment.** Record one minute of chunk keys and version numbers, and count how many change per second in a normal room.

## Side ideas, enabled by the same mesh

- **Flashlight and shadows.** The pool of light under a fingertip could light the real surface, with a soft shadow from the hand.
- **Occlusion.** Virtual pieces behind a real edge could be hidden by the mesh. The depth test is already there; the mesh would need to write depth.

## Open questions

- Do the time-warped surfaces need to match the room exactly, or is a convincing wobble enough?
- Should a snapshot's colour come from the camera at capture time, or stay as the piece's picture?
- How long should a ghost replay run before it costs too much on a Quest?
