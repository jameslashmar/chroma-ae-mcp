/**
 * A small simulated After Effects DOM for running panel/host/*.jsx under
 * node:vm in tests: keyframed properties, a layer stack (add, move,
 * precompose, track mattes old and new), markers, project items, folders and
 * the render queue. It follows AE's behaviour where the host code depends on
 * it (keys replace at the same time, roving only on spatial properties and
 * middle keys, indexes shift when layers move); everything else is simple.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

export const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };
export const PropertyValueType = {
  NO_VALUE: 6412,
  ThreeD_SPATIAL: 6413,
  ThreeD: 6414,
  TwoD_SPATIAL: 6415,
  TwoD: 6416,
  OneD: 6417,
  COLOR: 6418,
  CUSTOM_VALUE: 6419,
  MARKER: 6420,
  LAYER_INDEX: 6421,
  MASK_INDEX: 6422,
  SHAPE: 6423,
  TEXT_DOCUMENT: 6424,
};
export const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
export const TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
export const LightType = { PARALLEL: 4412, SPOT: 4413, POINT: 4414, AMBIENT: 4415 };
export const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 };

export class KeyframeEase {
  constructor(public speed: number, public influence: number) {}
}

export class MarkerValue {
  duration = 0;
  chapter = "";
  url = "";
  label = 0;
  cuePointName = "";
  constructor(public comment: string) {}
}

export class TextDocument {
  font = "ArialMT";
  fontFamily = "Arial";
  fontStyle = "Regular";
  fontLocation = "";
  fontObject: { isSubstitute: boolean } | undefined;
  fontSize = 72;
  applyFill = true;
  fillColor = [1, 1, 1];
  applyStroke = false;
  strokeColor = [0, 0, 0];
  constructor(public text: string) {}
}

export class Shape {
  vertices: number[][] = [];
  inTangents: number[][] = [];
  outTangents: number[][] = [];
  closed = true;
}

/** ExtendScript's File, looking at the real disk. */
export class FakeFile {
  constructor(public fsName: string) {}
  get exists() {
    return fs.existsSync(this.fsName);
  }
}

export class CompItem {}
export class FolderItem {}
export class FootageItem {}
export class SolidSource {}
export class PlaceholderSource {}
export class FileSource {}

interface Key {
  time: number;
  value: unknown;
  inI: number;
  outI: number;
  inEase: KeyframeEase[];
  outEase: KeyframeEase[];
  roving: boolean;
}

/**
 * Arrays the host code builds come from the vm's realm, where `instanceof
 * Array` (bound to this realm's Array) is false. AE has one realm, so copy
 * them into this one on the way in.
 */
const local = (v: unknown): unknown => (Array.isArray(v) ? Array.from(v, local) : v);

const lerp = (a: unknown, b: unknown, u: number): unknown => {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * u;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => (x as number) + (((b[i] as number) ?? x) - (x as number)) * u);
  return u < 1 ? a : b;
};

export class FakeProperty {
  propertyType = PropertyType.PROPERTY;
  canVaryOverTime = true;
  canSetExpression = true;
  expression = "";
  expressionEnabled = false;
  propertyIndex = 1;
  parentProperty: FakeGroup | null = null;
  keys: Key[] = [];
  constructor(
    public name: string,
    public matchName: string,
    public propertyValueType: number,
    public staticValue: unknown,
    public isSpatial = false
  ) {}
  get numKeys() {
    return this.keys.length;
  }
  private k(i: number): Key {
    const key = this.keys[i - 1];
    if (!key) throw new Error(`Key index ${i} out of range`);
    return key;
  }
  keyTime(i: number) {
    return this.k(i).time;
  }
  keyValue(i: number) {
    return this.k(i).value;
  }
  get value() {
    return this.keys.length ? this.valueAtTime(0, false) : this.staticValue;
  }
  setValue(v: unknown) {
    if (this.keys.length) throw new Error("Can't setValue on a keyframed property");
    this.staticValue = local(v);
  }
  setValueAtTime(t: number, raw: unknown) {
    const v = local(raw);
    const at = this.keys.findIndex((k) => Math.abs(k.time - t) < 1e-9);
    const ease = [new KeyframeEase(0, 16.666667)];
    const key: Key = { time: t, value: v, inI: KeyframeInterpolationType.LINEAR, outI: KeyframeInterpolationType.LINEAR, inEase: ease, outEase: ease, roving: false };
    if (at >= 0) this.keys[at] = { ...this.keys[at], value: v };
    else {
      this.keys.push(key);
      this.keys.sort((a, b) => a.time - b.time);
    }
  }
  setValuesAtTimes(ts: number[], vs: unknown[]) {
    if (ts.length !== vs.length) throw new Error("setValuesAtTimes: lengths differ");
    ts.forEach((t, i) => this.setValueAtTime(t, vs[i]));
  }
  setValueAtKey(i: number, raw: unknown) {
    this.k(i).value = local(raw);
  }
  removeKey(i: number) {
    this.k(i);
    this.keys.splice(i - 1, 1);
  }
  nearestKeyIndex(t: number) {
    let best = 1;
    this.keys.forEach((k, i) => {
      if (Math.abs(k.time - t) < Math.abs(this.keys[best - 1].time - t)) best = i + 1;
    });
    return best;
  }
  valueAtTime(t: number, _pre: boolean) {
    const ks = this.keys;
    if (!ks.length) return this.staticValue;
    if (t <= ks[0].time) return ks[0].value;
    if (t >= ks[ks.length - 1].time) return ks[ks.length - 1].value;
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      if (t >= a.time && t <= b.time) {
        if (a.outI === KeyframeInterpolationType.HOLD) return a.value;
        return lerp(a.value, b.value, (t - a.time) / (b.time - a.time));
      }
    }
    return ks[ks.length - 1].value;
  }
  setInterpolationTypeAtKey(i: number, inI: number, outI?: number) {
    this.k(i).inI = inI;
    this.k(i).outI = outI ?? inI;
  }
  keyInInterpolationType(i: number) {
    return this.k(i).inI;
  }
  keyOutInterpolationType(i: number) {
    return this.k(i).outI;
  }
  setTemporalEaseAtKey(i: number, inE: KeyframeEase[], outE?: KeyframeEase[]) {
    this.k(i).inEase = inE;
    this.k(i).outEase = outE ?? inE;
  }
  keyInTemporalEase(i: number) {
    return this.k(i).inEase;
  }
  keyOutTemporalEase(i: number) {
    return this.k(i).outEase;
  }
  keyRoving(i: number) {
    return this.k(i).roving;
  }
  setRovingAtKey(i: number, on: boolean) {
    if (!this.isSpatial) throw new Error("Roving is only for spatial properties");
    if (i === 1 || i === this.keys.length) throw new Error("The first and last keys can't rove");
    this.k(i).roving = on;
  }
  keySpatialContinuous() {
    return false;
  }
  keySpatialAutoBezier() {
    return false;
  }
  keyTemporalContinuous() {
    return false;
  }
  keyTemporalAutoBezier() {
    return false;
  }
  keyInSpatialTangent() {
    return [0, 0, 0];
  }
  remove() {
    this.parentProperty?.detach(this);
  }
  canAddToMotionGraphicsTemplate(_comp: FakeComp) {
    return this.propertyValueType !== PropertyValueType.CUSTOM_VALUE;
  }
  addToMotionGraphicsTemplate(comp: FakeComp) {
    comp.controllers.push(this.name);
  }
  addToMotionGraphicsTemplateAs(comp: FakeComp, name: string) {
    comp.controllers.push(name);
  }
  keyOutSpatialTangent() {
    return [0, 0, 0];
  }
}

const P = (name: string, matchName: string, type: number, value: unknown) => new FakeProperty(name, matchName, type, value);

/** What addProperty makes inside shape contents, keyed by match name. */
const SHAPE_FACTORY: Record<string, (n: number) => FakeGroup> = {
  "ADBE Vector Group": (n) =>
    new FakeGroup(`Group ${n}`, "ADBE Vector Group", [
      new FakeGroup("Contents", "ADBE Vectors Group", [], true),
      new FakeGroup("Transform", "ADBE Vector Transform Group", [P("Position", "ADBE Vector Position", PropertyValueType.TwoD, [0, 0])]),
    ]),
  "ADBE Vector Shape - Rect": (n) =>
    new FakeGroup(`Rectangle Path ${n}`, "ADBE Vector Shape - Rect", [
      P("Size", "ADBE Vector Rect Size", PropertyValueType.TwoD, [100, 100]),
      P("Position", "ADBE Vector Rect Position", PropertyValueType.TwoD_SPATIAL, [0, 0]),
      P("Roundness", "ADBE Vector Rect Roundness", PropertyValueType.OneD, 0),
    ]),
  "ADBE Vector Shape - Ellipse": (n) =>
    new FakeGroup(`Ellipse Path ${n}`, "ADBE Vector Shape - Ellipse", [
      P("Size", "ADBE Vector Ellipse Size", PropertyValueType.TwoD, [100, 100]),
      P("Position", "ADBE Vector Ellipse Position", PropertyValueType.TwoD_SPATIAL, [0, 0]),
    ]),
  "ADBE Vector Shape - Star": (n) =>
    new FakeGroup(`Polystar Path ${n}`, "ADBE Vector Shape - Star", [
      P("Type", "ADBE Vector Star Type", PropertyValueType.OneD, 1),
      P("Points", "ADBE Vector Star Points", PropertyValueType.OneD, 5),
      P("Position", "ADBE Vector Star Position", PropertyValueType.TwoD_SPATIAL, [0, 0]),
      P("Rotation", "ADBE Vector Star Rotation", PropertyValueType.OneD, 0),
      P("Inner Radius", "ADBE Vector Star Inner Radius", PropertyValueType.OneD, 50),
      P("Outer Radius", "ADBE Vector Star Outer Radius", PropertyValueType.OneD, 100),
    ]),
  "ADBE Vector Shape - Group": (n) => new FakeGroup(`Path ${n}`, "ADBE Vector Shape - Group", [P("Path", "ADBE Vector Shape", PropertyValueType.SHAPE, new Shape())]),
  "ADBE Vector Graphic - Fill": (n) =>
    new FakeGroup(`Fill ${n}`, "ADBE Vector Graphic - Fill", [
      P("Color", "ADBE Vector Fill Color", PropertyValueType.COLOR, [1, 0, 0, 1]),
      P("Opacity", "ADBE Vector Fill Opacity", PropertyValueType.OneD, 100),
    ]),
  "ADBE Vector Graphic - Stroke": (n) =>
    new FakeGroup(`Stroke ${n}`, "ADBE Vector Graphic - Stroke", [
      P("Color", "ADBE Vector Stroke Color", PropertyValueType.COLOR, [1, 1, 1, 1]),
      P("Stroke Width", "ADBE Vector Stroke Width", PropertyValueType.OneD, 2),
      P("Opacity", "ADBE Vector Stroke Opacity", PropertyValueType.OneD, 100),
    ]),
};

class FakeMask extends Object {}

const TEXT_ANIM_PROPS: Record<string, [string, number, unknown]> = {
  "ADBE Text Position 3D": ["Position", PropertyValueType.ThreeD_SPATIAL, [0, 0, 0]],
  "ADBE Text Scale 3D": ["Scale", PropertyValueType.ThreeD, [100, 100, 100]],
  "ADBE Text Rotation": ["Rotation", PropertyValueType.OneD, 0],
  "ADBE Text Opacity": ["Opacity", PropertyValueType.OneD, 100],
  "ADBE Text Fill Color": ["Fill Color", PropertyValueType.COLOR, [1, 0, 0, 1]],
  "ADBE Text Tracking Amount": ["Tracking Amount", PropertyValueType.OneD, 0],
  "ADBE Text Blur": ["Blur", PropertyValueType.TwoD, [0, 0]],
};

const MORE_FACTORY: Record<string, (n: number) => FakeGroup | FakeProperty> = {
  "ADBE Mask Atom": (n) => {
    const g = new FakeGroup(`Mask ${n}`, "ADBE Mask Atom", [
      P("Mask Path", "ADBE Mask Shape", PropertyValueType.SHAPE, new Shape()),
      P("Mask Feather", "ADBE Mask Feather", PropertyValueType.TwoD, [0, 0]),
      P("Mask Opacity", "ADBE Mask Opacity", PropertyValueType.OneD, 100),
      P("Mask Expansion", "ADBE Mask Offset", PropertyValueType.OneD, 0),
    ]) as FakeGroup & { maskMode: number; inverted: boolean };
    g.maskMode = MaskMode.ADD;
    g.inverted = false;
    return g;
  },
  "ADBE Text Animator": (n) =>
    new FakeGroup(`Animator ${n}`, "ADBE Text Animator", [
      new FakeGroup("Selectors", "ADBE Text Selectors", [], true),
      new FakeGroup("Properties", "ADBE Text Animator Properties", [], true),
    ]),
  "ADBE Text Selector": (n) =>
    new FakeGroup(`Range Selector ${n}`, "ADBE Text Selector", [
      P("Start", "ADBE Text Percent Start", PropertyValueType.OneD, 0),
      P("End", "ADBE Text Percent End", PropertyValueType.OneD, 100),
      P("Offset", "ADBE Text Percent Offset", PropertyValueType.OneD, 0),
      new FakeGroup("Advanced", "ADBE Text Range Advanced", [
        P("Units", "ADBE Text Range Units", PropertyValueType.OneD, 1),
        P("Based On", "ADBE Text Range Type2", PropertyValueType.OneD, 1),
        P("Shape", "ADBE Text Range Shape", PropertyValueType.OneD, 1),
        P("Ease High", "ADBE Text Levels Max Ease", PropertyValueType.OneD, 0),
        P("Ease Low", "ADBE Text Levels Min Ease", PropertyValueType.OneD, 0),
        P("Randomize Order", "ADBE Text Randomize Order", PropertyValueType.OneD, 0),
      ]),
    ]),
};
for (const [mn, [name, type, value]] of Object.entries(TEXT_ANIM_PROPS)) MORE_FACTORY[mn] = () => P(name, mn, type, value);
void FakeMask;

export class FakeGroup {
  propertyType: number;
  parentProperty: FakeGroup | null = null;
  constructor(public name: string, public matchName: string, public props: Array<FakeProperty | FakeGroup>, indexed = false) {
    this.propertyType = indexed ? PropertyType.INDEXED_GROUP : PropertyType.NAMED_GROUP;
    for (const p of props) p.parentProperty = this;
  }
  get numProperties() {
    return this.props.length;
  }
  property(sel: string | number) {
    if (typeof sel === "number") return this.props[sel - 1] ?? null;
    return this.props.find((p) => p.matchName === sel || p.name === sel) ?? null;
  }
  addProperty(matchName: string) {
    const make = SHAPE_FACTORY[matchName] ?? MORE_FACTORY[matchName];
    if (!make || this.propertyType !== PropertyType.INDEXED_GROUP) throw new Error(`Can't add ${matchName} to ${this.name}`);
    const made = make(this.props.filter((p) => p.matchName === matchName).length + 1);
    made.parentProperty = this;
    this.props.push(made);
    return made;
  }
  detach(p: FakeProperty | FakeGroup) {
    this.props = this.props.filter((x) => x !== p);
  }
  remove() {
    this.parentProperty?.detach(this);
  }
}

let nextId = 1000;

export class FakeLayer {
  id = nextId++;
  enabled = true;
  inPoint = 0;
  outPoint: number;
  startTime = 0;
  stretch = 100;
  threeDLayer = false;
  parent: FakeLayer | null = null;
  nullLayer = false;
  adjustmentLayer = false;
  guideLayer = false;
  hasVideo = true;
  hasAudio = false;
  audioEnabled = true;
  locked = false;
  label = 0;
  source: unknown = null;
  lightType: number | undefined;
  trackMatteType = TrackMatteType.NO_TRACK_MATTE;
  trackMatteLayer: FakeLayer | null = null;
  rect = { left: 0, top: 0, width: 100, height: 100 };
  reflect: { name: string };
  group: FakeGroup;
  /** False simulates AE before 23: no setTrackMatte, the matte is the layer above. */
  setTrackMatte?: (matte: FakeLayer, type: number) => void;
  removeTrackMatte?: () => void;
  constructor(public comp: FakeComp, public name: string, kind = "AVLayer") {
    this.reflect = { name: kind };
    this.outPoint = comp.duration;
    const transform = new FakeGroup("Transform", "ADBE Transform Group", [
      new FakeProperty("Anchor Point", "ADBE Anchor Point", PropertyValueType.ThreeD_SPATIAL, [0, 0, 0], true),
      new FakeProperty("Position", "ADBE Position", PropertyValueType.ThreeD_SPATIAL, [comp.width / 2, comp.height / 2, 0], true),
      new FakeProperty("Scale", "ADBE Scale", PropertyValueType.ThreeD, [100, 100, 100]),
      new FakeProperty("Rotation", "ADBE Rotate Z", PropertyValueType.OneD, 0),
      new FakeProperty("Opacity", "ADBE Opacity", PropertyValueType.OneD, 100),
    ]);
    const props: Array<FakeProperty | FakeGroup> = [
      new FakeProperty("Marker", "ADBE Marker", PropertyValueType.MARKER, null),
      transform,
      new FakeGroup("Effects", "ADBE Effect Parade", []),
      new FakeGroup("Masks", "ADBE Mask Parade", [], true),
    ];
    if (kind === "ShapeLayer") props.push(new FakeGroup("Contents", "ADBE Root Vectors Group", [], true));
    if (kind === "TextLayer") {
      props.push(
        new FakeGroup("Text", "ADBE Text Properties", [
          new FakeProperty("Source Text", "ADBE Text Document", PropertyValueType.TEXT_DOCUMENT, new TextDocument(name)),
          new FakeGroup("Animators", "ADBE Text Animators", [], true),
        ])
      );
    }
    this.group = new FakeGroup(name, "ADBE AV Layer", props);
    if (comp.modernMattes) {
      this.setTrackMatte = (matte, type) => {
        this.trackMatteLayer = matte;
        this.trackMatteType = type;
      };
      this.removeTrackMatte = () => {
        this.trackMatteLayer = null;
        this.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
      };
    }
  }
  get index() {
    return this.comp.stack.indexOf(this) + 1;
  }
  get containingComp() {
    return this.comp;
  }
  get isTrackMatte() {
    if (this.comp.modernMattes) return this.comp.stack.some((l) => l.trackMatteLayer === this);
    const below = this.comp.stack[this.index];
    return Boolean(below && below.trackMatteType !== TrackMatteType.NO_TRACK_MATTE);
  }
  get numProperties() {
    return this.group.numProperties;
  }
  property(sel: string | number) {
    if (sel === "ADBE Layer Overrides") return this.overrides();
    return this.group.property(sel);
  }
  private overrideGroup: FakeGroup | null = null;
  /** A precomp layer of a templated comp has one Essential Property per controller. */
  private overrides() {
    const src = this.source as FakeComp | null;
    if (!(src instanceof FakeComp) || !src.controllers.length) return null;
    this.overrideGroup ??= new FakeGroup("Essential Properties", "ADBE Layer Overrides", src.controllers.map((c) => P(c, c, PropertyValueType.OneD, 0)));
    return this.overrideGroup;
  }
  transform(name: string) {
    return (this.group.property("ADBE Transform Group") as FakeGroup).property(name) as FakeProperty;
  }
  sourceRectAtTime() {
    return { ...this.rect };
  }
  private move(to: number) {
    const s = this.comp.stack;
    s.splice(s.indexOf(this), 1);
    s.splice(to, 0, this);
  }
  moveBefore(other: FakeLayer) {
    this.move(this.comp.stack.indexOf(other) - (this.comp.stack.indexOf(this) < this.comp.stack.indexOf(other) ? 1 : 0));
  }
  moveAfter(other: FakeLayer) {
    this.move(this.comp.stack.indexOf(other) + (this.comp.stack.indexOf(this) < this.comp.stack.indexOf(other) ? 0 : 1));
  }
  moveToEnd() {
    this.move(this.comp.stack.length - 1);
  }
}

export class FakeComp extends CompItem {
  id = nextId++;
  pixelAspect = 1;
  frameRate = 25;
  time = 0;
  workAreaStart = 0;
  workAreaDuration: number;
  displayStartTime = 0;
  stack: FakeLayer[] = [];
  parentFolder: FakeFolder | null = null;
  markerProperty = new FakeProperty("Marker", "ADBE Marker", PropertyValueType.MARKER, null);
  modernMattes = true;
  motionGraphicsTemplateName = "";
  controllers: string[] = [];
  layers: Record<string, (...a: any[]) => any>;
  constructor(public project: FakeProject, public name: string, public width = 640, public height = 360, public duration = 3) {
    super();
    this.workAreaDuration = duration;
    const add = (l: FakeLayer) => {
      this.stack.unshift(l);
      return l;
    };
    this.layers = {
      addSolid: (color: number[], name: string, w: number, h: number, _pa: number, dur?: number) => {
        const item = project.addFootage(name, w, h, Object.assign(new SolidSource(), { color: local(color) }));
        const l = new FakeLayer(this, name);
        l.source = item;
        l.rect = { left: 0, top: 0, width: w, height: h };
        if (dur !== undefined) l.outPoint = dur;
        return add(l);
      },
      addNull: (dur?: number) => {
        const l = new FakeLayer(this, "Null 1");
        l.nullLayer = true;
        if (dur !== undefined) l.outPoint = dur;
        return add(l);
      },
      addText: (text: string) => add(new FakeLayer(this, text || "Text", "TextLayer")),
      addBoxText: (size: number[], text: string) => {
        const l = new FakeLayer(this, text || "Text", "TextLayer");
        l.rect = { left: -size[0] / 2, top: -size[1] / 2, width: size[0], height: size[1] };
        return add(l);
      },
      addShape: () => add(new FakeLayer(this, "Shape Layer 1", "ShapeLayer")),
      addCamera: (name: string) => add(new FakeLayer(this, name, "CameraLayer")),
      addLight: (name: string) => {
        const l = new FakeLayer(this, name, "LightLayer");
        l.lightType = LightType.POINT;
        return add(l);
      },
      add: (item: any, dur?: number) => {
        const l = new FakeLayer(this, item.name);
        l.source = item;
        l.rect = { left: 0, top: 0, width: item.width, height: item.height };
        if (dur !== undefined) l.outPoint = dur;
        return add(l);
      },
      precompose: (indexes: number[], name: string, moveAll: boolean) => {
        const moving = indexes.map((i) => this.stack[i - 1]);
        const first = this.stack[indexes[0] - 1];
        const inner = project.addComp(name, moveAll ? this.width : first.rect.width, moveAll ? this.height : first.rect.height, this.duration);
        const at = Math.min(...indexes) - 1;
        this.stack = this.stack.filter((l) => !moving.includes(l));
        for (const l of moving) {
          l.comp = inner;
          inner.stack.push(l);
        }
        const pl = new FakeLayer(this, name);
        pl.source = inner;
        pl.rect = { left: 0, top: 0, width: inner.width, height: inner.height };
        this.stack.splice(at, 0, pl);
        return inner;
      },
    };
  }
  get numLayers() {
    return this.stack.length;
  }
  get frameDuration() {
    return 1 / this.frameRate;
  }
  get motionGraphicsTemplateControllerCount() {
    return this.controllers.length;
  }
  getMotionGraphicsTemplateControllerName(i: number) {
    return this.controllers[i - 1];
  }
  setMotionGraphicsControllerName(i: number, name: string) {
    this.controllers[i - 1] = name;
  }
  exported: Array<{ overwrite: boolean; path?: string }> = [];
  exportAsMotionGraphicsTemplate(overwrite: boolean, path?: string) {
    this.exported.push({ overwrite, path });
    if (path) fs.writeFileSync(path, "mogrt");
    return true;
  }
  layer(sel: number | string) {
    if (typeof sel === "number") return this.stack[sel - 1] ?? null;
    return this.stack.find((l) => l.name === sel) ?? null;
  }
}

export class FakeFolder extends FolderItem {
  id = nextId++;
  parentFolder: FakeFolder | null = null;
  constructor(public project: FakeProject, public name: string) {
    super();
  }
  get children() {
    return this.project.all.filter((it: any) => it.parentFolder === this);
  }
  get numItems() {
    return this.children.length;
  }
  item(i: number) {
    return this.children[i - 1];
  }
  remove() {
    this.project.all = this.project.all.filter((x) => x !== this);
  }
}

export class FakeFootage extends FootageItem {
  id = nextId++;
  parentFolder: FakeFolder | null = null;
  duration = 0;
  footageMissing = false;
  file: { fsName: string } | null = null;
  project: FakeProject | null = null;
  constructor(public name: string, public width: number, public height: number, public mainSource: any) {
    super();
  }
  get usedIn() {
    return (this.project?.all ?? []).filter((c): c is FakeComp => c instanceof FakeComp && c.stack.some((l) => l.source === this));
  }
  remove() {
    if (this.project) this.project.all = this.project.all.filter((x) => x !== this);
  }
  replace(f: FakeFile) {
    this.file = { fsName: f.fsName };
    this.footageMissing = false;
  }
  replaceWithSequence(f: FakeFile) {
    this.file = { fsName: f.fsName };
    this.mainSource = Object.assign(new FileSource(), { isStill: false });
  }
}

export class FakeProject {
  all: Array<FakeComp | FakeFolder | FakeFootage> = [];
  rootFolder: FakeFolder;
  file: { fsName: string } | null = null;
  dirty = false;
  renderQueue = makeRenderQueue();
  constructor() {
    this.rootFolder = new FakeFolder(this, "Root");
  }
  get numItems() {
    return this.all.length;
  }
  item(i: number) {
    return this.all[i - 1];
  }
  itemByID(id: number) {
    return this.all.find((it) => it.id === id) ?? null;
  }
  private place<T extends { parentFolder: FakeFolder | null }>(it: T, folder?: FakeFolder): T {
    it.parentFolder = folder ?? this.rootFolder;
    this.all.push(it as any);
    return it;
  }
  addComp(name: string, w = 640, h = 360, dur = 3, folder?: FakeFolder) {
    return this.place(new FakeComp(this, name, w, h, dur), folder);
  }
  addFolder(name: string, folder?: FakeFolder) {
    return this.place(new FakeFolder(this, name), folder);
  }
  addFootage(name: string, w: number, h: number, source: unknown = new FileSource(), folder?: FakeFolder) {
    const f = this.place(new FakeFootage(name, w, h, source), folder);
    f.project = this;
    return f;
  }
}

export const RS_TEMPLATES = ["Best Settings", "Draft Settings", "Multi-Machine Settings"];
export const OM_TEMPLATES = ["Lossless", "AIFF 48kHz", "High Quality with Alpha"];

function makeRenderQueue() {
  const items: any[] = [];
  return {
    items: Object.assign(items, {
      add(comp: FakeComp) {
        const item = {
          comp,
          templates: RS_TEMPLATES,
          outputModule: () => ({ templates: OM_TEMPLATES }),
          remove: () => items.splice(items.indexOf(item), 1),
        };
        items.push(item);
        return item;
      },
    }),
    get numItems() {
      return items.length;
    },
    item(i: number) {
      return items[i - 1];
    },
  };
}

const HOST_DIR = path.resolve(__dirname, "../../../panel/host");

/** Loads core.jsx and the given ext files into a fresh context over `project`. */
export function loadHost(project: FakeProject, extFiles: string[], extra: Record<string, unknown> = {}) {
  const undo = { begun: 0, ended: 0 };
  const G: Record<string, any> = {
    Array,
    CompItem,
    FolderItem,
    FootageItem,
    SolidSource,
    PlaceholderSource,
    TextDocument,
    MarkerValue,
    Shape,
    File: FakeFile,
    FileSource,
    KeyframeEase,
    PropertyType,
    PropertyValueType,
    KeyframeInterpolationType,
    TrackMatteType,
    LightType,
    MaskMode,
    app: {
      project,
      version: "26.2.1",
      beginUndoGroup: () => undo.begun++,
      endUndoGroup: () => undo.ended++,
      ...extra,
    },
  };
  G.$ = { global: G, os: "Windows 11" };
  vm.createContext(G);
  for (const f of ["core.jsx", ...extFiles.map((x) => `ext/${x}`)]) {
    vm.runInContext(fs.readFileSync(path.join(HOST_DIR, f), "utf8"), G, { filename: f });
  }
  return { A: G.__chromaAe, undo, G };
}

export const GUARD = { project_path: "<unsaved>" };
