// Heart viewer: switches between models and applies the layer opacities chosen on the panels, spins the heart with
// a swipe, lets hands grab and resize it, and highlights the structure under a quick pinch or click.
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractableManipulation} from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import {HandInteractor} from "SpectaclesInteractionKit.lspkg/Core/HandInteractor/HandInteractor"
import {Interactor, InteractorInputType} from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {ControlChange, HeartLayersUI, LAYERS, makeText} from "./HeartLayersUI"

type Part = {visual: RenderMeshVisual; pass: Pass; color: vec4; collider: ColliderComponent}
type Model = {so: SceneObject; halfExtent: vec3; parts: Map<string, Part>}

const MAX_SIZE = 5 // a two-hand grab can grow the heart to 5x: big enough to step inside
const MIN_SIZE = 0.3 // and shrink it to 0.3x
const TAP_TIME = 0.5 // s: a shorter pinch or click on a structure highlights it; a longer one only grabs the heart
const SWIPE_SPEED = 40 // cm/s across the view: slower hand or cursor movements are not swipes
const SPIN_GAIN = 0.04 // rad/s of spin per cm/s of swipe
const SPIN_DECAY = 0.8 // s for a spin to slow to about a third
const HOVER_GRACE = 0.4 // s: a swipe that starts on the heart still counts after the pointer slides off it
const SPEED_SMOOTHING = 0.3 // share of each new velocity sample kept; hand tracking is noisy
const NEW_DIRECTION = Math.PI / 4 // a swipe turned this far from the current spin takes over even if slower
const DISPLAY_HALF_HEIGHT = 8 // cm: the tallest model's half height; the others keep their true size relative to it
const NEUTRAL = new vec4(0.62, 0.62, 0.62, 0.2) // every other structure while one is highlighted
const LABELS = new Map(LAYERS)

@component
export class HeartViewer extends BaseScriptComponent {
  @ui.label("Heart viewer: models, layers, grabbing and highlighting")
  @ui.separator
  @input
  @hint("Parent of the heart models (GLBs made by tools/seg_to_glb.py), in button order")
  heartRoot: SceneObject

  @input
  @hint("Panel with the model buttons")
  modelsUI: HeartLayersUI

  @input
  @hint("Panel with one opacity button per structure")
  layersUI: HeartLayersUI

  private models: Model[] = []
  private scale = 1 // model units to cm, shared by all models so their sizes compare
  private active = 0
  private opacity = new Map<string, number>(LAYERS.map(([key]) => [key, 1]))
  private highlighted: string | null = null
  private camera = WorldCameraFinderProvider.getInstance()
  private aim: {interactor: Interactor; at: number} | null = null // who last pointed at the heart, and when
  private sweep: {by: Interactor; at: vec3} | null = null // who swiped last frame, and where they pointed
  private sweepVelocity = vec3.zero() // cm/s, smoothed
  private spin = vec3.zero() // rad/s; the direction is the axis
  private label: Text
  private markers: SceneObject[] = []

  onAwake() {
    const modelObjects = this.heartRoot.children // taken before the labels below join them
    this.label = makeText(this.heartRoot, "", 70, 500, 40, 6)
    this.markers = ["R", "L"].map((side) => makeText(this.heartRoot, side, 90, 500, 6, 6).getSceneObject())

    this.createEvent("OnStartEvent").bind(() => {
      for (const so of modelObjects) {
        const parts = this.collectParts(so)
        this.models.push({so, halfExtent: halfExtent(parts), parts})
      }
      this.scale = DISPLAY_HALF_HEIGHT / Math.max(...this.models.map((m) => m.halfExtent.y))
      // One Interactable for the whole heart; it picks up the structures' colliders (created above). Grabbing moves
      // and turns the heart with one hand and resizes it with two. A quick pinch or click highlights the structure hit.
      const interactable = this.heartRoot.createComponent(Interactable.getTypeName()) as Interactable
      const grab = this.heartRoot.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
      grab.minimumScaleFactor = MIN_SIZE
      grab.maximumScaleFactor = MAX_SIZE
      // The manipulation asks for filtered pinches (on its first frame, so undo it on hover); Lens Studio's webcam
      // hand tracking only sends unfiltered ones.
      if (global.deviceInfoSystem.isEditor()) interactable.onHoverEnter.add(() => (interactable.useFilteredPinch = false))
      let pressed = 0
      interactable.onTriggerStart.add(() => {
        pressed = getTime()
        this.spin = vec3.zero() // a grab takes over from a spin
      })
      interactable.onTriggerEnd.add((e) => {
        const part = e.interactor.targetHitInfo?.hit.collider.getSceneObject().name
        if (part && getTime() - pressed < TAP_TIME) this.toggleHighlight(part)
      })
      interactable.onHoverUpdate.add((e) => {
        // Pointing at the heart again, after pointing away, catches a spin: it stops right there.
        if (getTime() - (this.aim?.at ?? -Infinity) > HOVER_GRACE) this.spin = vec3.zero()
        this.aim = {interactor: e.interactor, at: getTime()}
      })
      this.createEvent("UpdateEvent").bind(() => this.spinWithSwipe())
      this.modelsUI.setModelCount(this.models.length)
      this.layersUI.setColors(LAYERS.map(([key]) => this.models[0].parts.get(key)?.color))
      this.showModel(0)
      this.modelsUI.onControlChange.add((c) => this.apply(c))
      this.layersUI.onControlChange.add((c) => this.apply(c))
    })
  }

  /** Highlights this structure (every other one turns neutral grey), or clears the highlight if it already is. */
  private toggleHighlight(part: string) {
    this.highlighted = this.highlighted === part ? null : part
    this.refresh()
  }

  /**
   * A quick swipe while pointing at the heart spins it like a trackball: the side facing you follows the swipe, left,
   * right, up or down, at the swipe's peak speed; the spin then slows down until you point at the heart again.
   * Moving slowly, pinching or pointing elsewhere does nothing.
   */
  private spinWithSwipe() {
    const dt = getDeltaTime()
    const aim = this.aim
    const last = this.sweep
    const pointing = aim !== null && getTime() - aim.at < HOVER_GRACE && !aim.interactor.isTriggering
    const at = pointing ? this.pointedAt(aim.interactor) : null
    this.sweep = at && {by: aim.interactor, at}
    const heart = this.heartRoot.getTransform()
    if (this.sweep && last?.by === this.sweep.by && dt > 0) {
      const velocity = this.sweep.at.sub(last.at).uniformScale(1 / dt)
      this.sweepVelocity = vec3.lerp(this.sweepVelocity, velocity, SPEED_SMOOTHING)
      const toViewer = this.camera.getWorldPosition().sub(heart.getWorldPosition()).normalize()
      const push = toViewer.cross(this.sweepVelocity) // spin axis, as long as the swipe's speed across the view
      const spin = push.uniformScale(SPIN_GAIN)
      if (push.length > SWIPE_SPEED && (spin.length > this.spin.length || spin.angleTo(this.spin) > NEW_DIRECTION)) this.spin = spin
    } else this.sweepVelocity = vec3.zero()
    const rate = this.spin.length
    if (rate < 0.01) {
      this.spin = vec3.zero()
      return
    }
    heart.setWorldRotation(quat.angleAxis(rate * dt, this.spin.normalize()).multiply(heart.getWorldRotation()))
    this.spin = this.spin.uniformScale(Math.exp(-dt / SPIN_DECAY))
  }

  /**
   * Where an interactor points, at the heart's distance. A hand keeps its pointing ray even while the ray is hidden,
   * which it often is mid-swipe; so a flick of the hand moves this point just like a flick of the mouse.
   */
  private pointedAt(interactor: Interactor): vec3 | null {
    const hand = (interactor.inputType & InteractorInputType.BothHands) !== 0 ? (interactor as HandInteractor) : null
    const start = hand ? hand.indirectStartPoint : interactor.startPoint
    const direction = hand ? hand.indirectDirection : interactor.direction
    if (!start || !direction) return null
    return start.add(direction.normalize().uniformScale(start.distance(this.heartRoot.getTransform().getWorldPosition())))
  }

  private apply({key, value}: ControlChange) {
    if (key === "model") this.showModel(value)
    else if (this.opacity.has(key)) {
      this.opacity.set(key, value)
      this.refresh()
    }
  }

  private showModel(index: number) {
    this.active = index
    this.highlighted = null
    this.models.forEach((m, i) => (m.so.enabled = i === index))
    const {so, halfExtent} = this.models[index]
    so.getTransform().setLocalScale(vec3.one().uniformScale(this.scale))
    const w = halfExtent.x * this.scale + 4
    this.markers[0].getTransform().setLocalPosition(new vec3(-w, 0, 0)) // patient's right is the viewer's left
    this.markers[1].getTransform().setLocalPosition(new vec3(w, 0, 0))
    this.label.getSceneObject().getTransform().setLocalPosition(new vec3(0, halfExtent.y * this.scale + 4, 0))
    this.refresh()
  }

  private refresh() {
    this.models[this.active].parts.forEach((p, name) => {
      const alpha = this.opacity.get(name) ?? 1
      p.collider.enabled = alpha > 0.5 // only clearly visible structures can be picked
      if (name === this.highlighted) this.paint(p, p.color, 1)
      else if (this.highlighted) this.paint(p, NEUTRAL, Math.min(alpha, NEUTRAL.w))
      else this.paint(p, p.color, alpha)
    })
    this.label.enabled = this.highlighted !== null
    if (this.highlighted) this.label.text = LABELS.get(this.highlighted) ?? this.highlighted
  }

  private paint(p: Part, color: vec4, alpha: number) {
    const solid = alpha > 0.99
    p.visual.enabled = alpha > 0.02
    p.pass.blendMode = solid ? BlendMode.Disabled : BlendMode.Normal
    p.pass.depthWrite = solid // a see-through structure must not hide what is behind it
    p.pass.baseColorFactor = new vec4(color.x, color.y, color.z, alpha)
  }

  private collectParts(root: SceneObject): Map<string, Part> {
    const parts = new Map<string, Part>()
    const visit = (so: SceneObject) => {
      const visual = so.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
      if (visual) {
        const material = visual.mainMaterial.clone() // own copy, so one structure changes alone
        visual.mainMaterial = material
        const shape = Shape.createMeshShape()
        shape.mesh = visual.mesh
        const collider = so.createComponent("Physics.ColliderComponent") as ColliderComponent
        collider.fitVisual = false
        collider.shape = shape
        parts.set(so.name, {visual, pass: material.mainPass, color: material.mainPass.baseColorFactor, collider})
      }
      for (let i = 0; i < so.getChildrenCount(); i++) visit(so.getChild(i))
    }
    visit(root)
    return parts
  }
}

/** Half size of a model's bounding box in its own (GLB) units; seg_to_glb.py centres every model on the origin. */
function halfExtent(parts: Map<string, Part>): vec3 {
  let min = new vec3(Infinity, Infinity, Infinity)
  let max = min.uniformScale(-1)
  parts.forEach(({visual}) => {
    min = vec3.min(min, visual.mesh.aabbMin)
    max = vec3.max(max, visual.mesh.aabbMax)
  })
  return max.sub(min).uniformScale(0.5)
}
