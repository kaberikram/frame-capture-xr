import { createComponent, Types } from '@iwsdk/core'

/**
 * Knobs for one capture. The inspector can nudge them on a headset;
 * the README lists the same fields.
 */
export const CaptureLook = createComponent('CaptureLook', {
  relief: {
    type: Types.Float32,
    default: 0.42,
    min: 0,
    max: 1.2,
    step: 0.01,
    label: 'Relief (× long side)',
    help: 'How far the nearest pixels come forward, as a share of the frame’s long side.',
  },
  pop: {
    type: Types.Float32,
    default: 0.85,
    min: 0.05,
    max: 3,
    step: 0.05,
    label: 'Pop (seconds)',
    help: 'How long the relief eases out of the frame.',
  },
  edge: {
    type: Types.Float32,
    default: 0.18,
    min: 0.01,
    max: 0.4,
    step: 0.005,
    label: 'Depth edge',
    help: 'Depth jump, in 0–1, where a silhouette starts to fade. Lower culls more.',
  },
  band: {
    type: Types.Float32,
    default: 0.1,
    min: 0.01,
    max: 0.4,
    step: 0.005,
    label: 'Edge feather',
    help: 'How wide the fade is past the depth edge, so cliffs do not leave a hard cut.',
  },
  feather: {
    type: Types.Float32,
    default: 0.018,
    min: 0,
    max: 0.12,
    step: 0.002,
    label: 'Photo feather',
    help: 'Soft inset where the photo meets the white frame, in UV.',
  },
  minSpan: {
    type: Types.Float32,
    default: 0.12,
    min: 0.04,
    max: 0.6,
    step: 0.01,
    label: 'Minimum side (m)',
    help: 'A drag shorter than this on either side is dropped.',
  },
  strip: {
    type: Types.Float32,
    default: 0.008,
    min: 0.002,
    max: 0.04,
    step: 0.001,
    label: 'Frame thickness (m)',
  },
  segments: {
    type: Types.Int16,
    default: 72,
    min: 16,
    max: 128,
    step: 4,
    label: 'Relief segments',
    help: 'Subdivisions along the long side of the displaced mesh.',
  },
})
