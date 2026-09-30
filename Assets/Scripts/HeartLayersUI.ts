// Heart control panels, built from the UI kit's primitives: big buttons that switch between the heart models,
// or one button per structure, in that structure's colour, that steps its opacity (solid, see-through, hidden).
// A panel always turns to face you; pinching or clicking its background, not a button, moves it.
import {FlexLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout"
import {FlexItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem"
import {FlexAlign, FlexDirection, FlexJustify} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import {GradientParameters} from "SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangle"
import {RoundedRectangleVisual} from "SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Billboard} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Billboard/Billboard"
import {InteractableManipulation} from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"

// [scene-object name written by tools/seg_to_glb.py, label]
export const LAYERS: [string, string][] = [
  ["HeartWall", "Wall (approx.)"],
  ["LeftVentricle", "Left ventricle"],
  ["RightVentricle", "Right ventricle"],
  ["LeftAtrium", "Left atrium"],
  ["RightAtrium", "Right atrium"],
  ["Aorta", "Aorta"],
  ["PulmonaryArtery", "Pulmonary artery"],
  ["PulmonaryVeins", "Pulmonary veins"],
  ["CoronaryArteries", "Coronary arteries"],
]
const OPACITY_STEPS = [1, 0.3, 0] // each press moves a structure to the next step: solid, see-through, hidden

/** A model button sends key "model" and the model's index; a layer button sends the structure's new opacity. */
export type ControlChange = {key: string; value: number}

const PANEL_WIDTH = 28
const PAD = 2.0
const GAP = 0.8
const BUTTON_WIDTH = (PANEL_WIDTH - PAD * 2 - GAP) / 2 // two buttons per row
const ACCENT = new vec4(0.92, 0.41, 0.37, 1) // the chosen model's button: the heart's own red
const MAX_LUMA = 0.45 // pale colours are dimmed to this brightness so the white labels stay readable

/** Centered text in a width x height (cm) rect, parented to `parent`. */
export function makeText(parent: SceneObject, value: string, size: number, weight: number, width: number, height: number): Text {
  const so = global.scene.createSceneObject("Text")
  so.setParent(parent)
  const text = so.createComponent("Component.Text") as Text
  text.text = value
  text.depthTest = true
  text.size = size
  ;(text as Text & {weight?: number}).weight = weight
  text.horizontalAlignment = HorizontalAlignment.Center
  text.verticalAlignment = VerticalAlignment.Center
  text.horizontalOverflow = HorizontalOverflow.Overflow
  text.verticalOverflow = VerticalOverflow.Overflow
  text.layoutRect = Rect.create(-width / 2, width / 2, -height / 2, height / 2)
  return text
}

@component
export class HeartLayersUI extends BaseScriptComponent {
  @ui.label("Heart panel: model buttons, or one opacity button per structure")
  @ui.separator
  @input
  @hint("Show one opacity button per structure instead of the model buttons")
  showLayers: boolean = false

  private changeEvent = new Event<ControlChange>()
  readonly onControlChange: PublicApi<ControlChange> = this.changeEvent.publicApi()
  private buttons: RoundedRectangleVisual[] = []
  private colors: (vec4 | undefined)[] = [] // per structure, as seen on screen
  private plain: {fill: GradientParameters; hover: GradientParameters} // the theme's grey
  private content: SceneObject
  private flex: FlexLayout

  onAwake() {
    this.sceneObject.createComponent("Component.Canvas")
    this.sceneObject.createComponent(Billboard.getTypeName()) // turns about the vertical to face you
    const backPlate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate

    const content = (this.content = global.scene.createSceneObject("Content"))
    content.setParent(this.sceneObject)
    content.getTransform().setLocalPosition(new vec3(0, 0, 0.6)) // lift content off the plate (z-fighting)

    const flex = (this.flex = content.createComponent(FlexLayout.getTypeName()) as FlexLayout)
    flex.width = PANEL_WIDTH
    flex.height = -1
    flex.direction = FlexDirection.Column
    flex.justifyContent = FlexJustify.Start
    flex.alignItems = FlexAlign.Stretch
    flex.rowGap = GAP
    flex.paddingTop = PAD
    flex.paddingBottom = PAD
    flex.paddingLeft = PAD
    flex.paddingRight = PAD
    flex.onLayoutComplete.add((r) => (backPlate.size = new vec2(r.containerWidth, r.containerHeight)))
    // Grabbing the back plate moves the panel. The plate makes its Interactable on start, after this script's own
    // start, so take it on the first frame.
    const makeMovable = this.createEvent("UpdateEvent")
    makeMovable.bind(() => {
      makeMovable.enabled = false
      const move = this.sceneObject.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
      move.setNewInteractable(backPlate.interactable)
      move.setCanRotate(false) // the billboard turns it
      // The manipulation asks for filtered pinches, which the buttons inherit; Lens Studio's webcam hand tracking
      // only sends unfiltered ones.
      if (global.deviceInfoSystem.isEditor()) backPlate.interactable.useFilteredPinch = false
    })

    const header = makeText(content, this.showLayers ? "Layers" : "Models", 93, 700, PANEL_WIDTH - PAD * 2, 4.5)
    const headerItem = header.getSceneObject().createComponent(FlexItem.getTypeName()) as FlexItem
    headerItem.marginBottom = 0.6

    if (!this.showLayers) return // HeartViewer adds the model buttons once it has found the models
    const steps = LAYERS.map(() => 0)
    this.addButtons(LAYERS.map(([, label]) => label), 3.6, 32, (i, text) => {
      steps[i] = (steps[i] + 1) % OPACITY_STEPS.length
      const value = OPACITY_STEPS[steps[i]]
      text.text = value === 1 ? LAYERS[i][1] : `${LAYERS[i][1]} ${value ? `${Math.round(value * 100)}%` : "off"}`
      this.paint(i, this.colors[i], value)
      this.changeEvent.invoke({key: LAYERS[i][0], value})
    })
  }

  /** Model panel: one button per model, "Heart 1" to "Heart <count>", with the first one chosen. */
  setModelCount(count: number) {
    const choose = (chosen: number) => this.buttons.forEach((_, i) => this.paint(i, ACCENT, i === chosen ? 1 : 0))
    const names = Array.from({length: count}, (_, i) => `Heart ${i + 1}`)
    this.addButtons(names, 6, 60, (i) => {
      choose(i)
      this.changeEvent.invoke({key: "model", value: i})
    })
    choose(0)
  }

  /** Layer panel: gives each structure's button that structure's colour (glTF linear colours, in LAYERS order). */
  setColors(linear: (vec4 | undefined)[]) {
    this.colors = linear.map((c) => c && new vec4(Math.pow(c.x, 1 / 2.2), Math.pow(c.y, 1 / 2.2), Math.pow(c.z, 1 / 2.2), 1))
    this.colors.forEach((c, i) => this.paint(i, c, 1))
  }

  /** Fills a button with `color`, dimmer for see-through (0 < level < 1), or the theme's grey when hidden or colourless. */
  private paint(i: number, color: vec4 | undefined, level: number) {
    const button = this.buttons[i]
    if (!color || level === 0) {
      button.defaultGradient = this.plain.fill
      button.hoveredGradient = this.plain.hover
      return
    }
    const luma = 0.2126 * color.x + 0.7152 * color.y + 0.0722 * color.z
    const brightness = (0.35 + 0.45 * level) * Math.min(1, MAX_LUMA / luma)
    button.defaultGradient = gradient(color, brightness)
    button.hoveredGradient = gradient(color, brightness + 0.2)
  }

  /** Buttons two to a row; `onPress` gets the button's index and its label. */
  private addButtons(labels: string[], height: number, textSize: number, onPress: (i: number, label: Text) => void) {
    for (let first = 0; first < labels.length; first += 2) {
      const row = global.scene.createSceneObject("Row")
      row.setParent(this.content)
      const rowFlex = row.createComponent(FlexLayout.getTypeName()) as FlexLayout
      rowFlex.direction = FlexDirection.Row
      rowFlex.justifyContent = FlexJustify.Start
      rowFlex.alignItems = FlexAlign.Center
      rowFlex.columnGap = GAP
      rowFlex.width = -1
      rowFlex.height = height
      row.createComponent(FlexItem.getTypeName())
      for (let i = first; i < Math.min(first + 2, labels.length); i++) {
        const so = global.scene.createSceneObject(labels[i])
        so.setParent(row)
        const button = so.createComponent(Button.getTypeName()) as Button
        button.size = new vec3(BUTTON_WIDTH, height, 1) // size must be set before the button initializes
        button.initialize() // now, not on start, so its colours can be set right away
        const visual = button.visual as RoundedRectangleVisual
        this.plain ??= {fill: visual.defaultGradient, hover: visual.hoveredGradient}
        this.buttons.push(visual)
        const label = makeText(so, labels[i], textSize, 500, BUTTON_WIDTH - 0.5, height)
        label.getSceneObject().getTransform().setLocalPosition(new vec3(0, 0, 0.08)) // in front of the button face
        so.createComponent(FlexItem.getTypeName())
        button.onTriggerUp.add(() => onPress(i, label))
      }
      rowFlex.refreshChildren() // layouts find their items on start, which may have passed
    }
    this.flex.refreshChildren()
  }
}

/** A button fill in the theme's shape (dark corner to full colour), at `brightness` times `color`. */
function gradient(color: vec4, brightness: number): GradientParameters {
  const shade = (k: number) => new vec4(color.x * k, color.y * k, color.z * k, 1)
  return {
    type: "Linear",
    start: new vec2(-2, 1),
    end: new vec2(2, -1),
    stop0: {percent: 0, color: shade(brightness * 0.55)},
    stop1: {percent: 1, color: shade(brightness)},
  }
}
