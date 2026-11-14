import { World } from '@iwsdk/core'
import projectOptions from 'virtual:iwsdk-project'
import { CaptureSystem } from './app/capture-system.js'
import { PEEL, prepareOffer } from './app/experience.js'

const container = document.getElementById('scene-container')
if (!(container instanceof HTMLDivElement)) throw new Error('Missing #scene-container')

// The peel page builds its room from live depth. It does not ask for the
// Space Setup scan (planes and meshes) or hit-test, which only frame capture uses.
const xr = projectOptions.xr
const options =
  PEEL && xr ? { ...projectOptions, xr: { ...xr, features: { ...xr.features, planeDetection: false, meshDetection: false, hitTest: false } } } : projectOptions
prepareOffer(PEEL)

void World.create(container, options).then((world) => {
  world.registerSystem(CaptureSystem)
})
