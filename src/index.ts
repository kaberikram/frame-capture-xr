import { World } from '@iwsdk/core'
import projectOptions from 'virtual:iwsdk-project'
import { CaptureSystem } from './capture-system.js'

const container = document.getElementById('scene-container')
if (!(container instanceof HTMLDivElement)) throw new Error('Missing #scene-container')

void World.create(container, projectOptions).then((world) => {
  world.registerSystem(CaptureSystem)
})
