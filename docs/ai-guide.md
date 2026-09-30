# Guide for AI coding assistants

Give this file to your assistant before asking it to run, change or extend Open Heart. It holds what the code alone
does not say: the rules the scripts rely on, how to check a change, and the problems that were already solved once.

## The project in one screen

- A Lens Studio 5.24+ project, `OpenHeart.esproj`, written in TypeScript components (`@component`, `BaseScriptComponent`).
  It targets AR glasses; the Preview panel's device should be the glasses, not a phone.
- A Python pipeline, `tools/seg_to_glb.py`, that turns a labelled whole-heart CT segmentation (NIfTI) into a GLB.

| Path | Role |
| --- | --- |
| `Assets/Scripts/HeartViewer.ts` | Finds the models, builds their colliders, applies layers, highlight, grab, two-hand scale and swipe spin |
| `Assets/Scripts/HeartLayersUI.ts` | The Models and Layers panels (UI components); exports `LAYERS`, `ControlChange`, `makeText` |
| `Assets/Scene.scene` | `HeartViewer` > `HeartRoot` > `Model_113`, `Model_133`, `Model_13`, `Model_91`; `LayersPanel` and `ViewPanel` beside them |
| `Assets/Models/heart_<case>.glb` | The example hearts, one mesh per structure |
| `tools/seg_to_glb.py` | Segmentation to GLB |

## Rules the code relies on

1. **One Interactable, on `HeartRoot` only.** The structures have colliders but no Interactable of their own: the
   interaction kit stops looking for colliders under a child that has one. The structure that was tapped comes from
   `interactor.targetHitInfo.hit.collider`.
2. **Every child of `HeartRoot` is a model**, and the Models panel numbers its buttons in child order. `HeartViewer`
   reads the children in `onAwake`, before it adds its own labels under the same root.
3. **Mesh names are keys.** The names the pipeline writes (`HeartWall`, `LeftAtrium`, ...) must match the keys in
   `LAYERS` in `HeartLayersUI.ts`.
4. **Colours stay bright.** glTF colours are linear, so the pipeline converts screen colours with `srgb()`. The glasses'
   see-through display turns dark colours transparent.
5. **Editor-only workarounds go behind `global.deviceInfoSystem.isEditor()`.** The glasses must keep the standard
   behaviour.
6. **No diagnosis.** The dataset has none; the project is for education only. Do not add wording or features that
   claim to detect or measure disease.

## Run it

1. Open `OpenHeart.esproj` in Lens Studio 5.24 or newer.
2. In the Preview panel's interactive room, a mouse click works as a pinch.
3. For hand tracking without glasses, use the webcam input with a camera worn on the forehead, and flip the image
   horizontally in the webcam app (the editor mirrors webcam input).

## Add a heart

```bash
pip install -r tools/requirements.txt
python tools/seg_to_glb.py <case>.img.nii.gz Assets/Models/heart_<case>.glb
```

Tested with Python 3.12; about three minutes per heart. The input uses labels 1–10 (myocardium, left atrium, left
ventricle, right atrium, right ventricle, aorta, pulmonary artery, left atrial appendage, coronary arteries, pulmonary
veins). Then drag the GLB under `HeartViewer/HeartRoot`. No code changes are needed.

## Check a change

- Recompile the TypeScript, reset the preview and read the Logger: a clean start prints only the interaction kit's
  version line.
- Click through: every Models button, each Layers button three times (solid, 30%, off), a quick tap on a structure
  (its name appears), a swipe on the heart, and a panel dragged by its background.
- After a pipeline change, regenerate one heart and compare its mesh names and triangle counts with the old GLB.

## Problems already solved

| Symptom | Cause | Fix in the code |
| --- | --- | --- |
| A pinch on the heart never grabs it in the webcam preview | The manipulation asks for filtered pinches; webcam tracking only sends unfiltered ones | `HeartViewer` turns filtered pinch off in the editor |
| Panel buttons stop reacting to webcam pinches | Buttons inherit the panel's filtered-pinch setting | `HeartLayersUI` turns it off in the editor |
| `Cannot set property 'keepHoverOnTrigger' of undefined` when a panel is made movable | The back plate creates its Interactable on its own start, after the panel script's start | Take the Interactable on the first frame |
| A button's colour does not change | The UI theme draws buttons with gradients | Call `initialize()`, then set `defaultGradient` and `hoveredGradient` |
| Buttons added after start are not laid out | The flex layout finds its items only on start | Call `refreshChildren()` after adding them |
| In the webcam preview the right hand is tracked as the left | The editor mirrors webcam input | Flip the image in the webcam app |
| A fresh clone has broken GLBs (tiny text files) | The editor writes a `.gitattributes` that stores assets in Git LFS | Keep `.gitattributes` ignored; `git check-attr filter -- <file>` must say `unspecified` |
| The swipe does nothing with simulated hands | A simulated hand has no pointing ray | Test the swipe with the mouse or on the glasses |

Do not commit `Cache/`, `Support/`, `Workspaces/` or `PluginsUserPreferences/`: the editor regenerates them.
