/* Tests for Unfold's scene normaliser. Hand-computed expectations, no network.
   Run: node --test core.test.js */

const test = require("node:test");
const assert = require("node:assert");
const U = require("./core.js");

const good = {
  title: "Why the sky is blue",
  blurb: "Sunlight enters the atmosphere and short wavelengths scatter hardest.",
  nodes: [
    { id: "sun", label: "Sunlight", role: "White light, all wavelengths together", x: 60, y: 240, w: 150, h: 70 },
    { id: "air", label: "Air molecules", role: "Small particles, far apart", x: 400, y: 220, w: 160, h: 80 },
    { id: "eye", label: "Your eye", role: "Sees the light that reaches it", x: 780, y: 240, w: 150, h: 70 }
  ],
  links: [
    { from: "sun", to: "air", label: "enters" },
    { from: "air", to: "eye", label: "scattered blue" }
  ],
  steps: [
    { title: "Light arrives", detail: "The sun sends every visible wavelength at once.", focus: ["sun"] },
    { title: "Short waves scatter", detail: "Blue light is scattered far more than red by molecules smaller than its wavelength.", focus: ["air", "sun"] },
    { title: "You see blue", detail: "Scattered blue reaches your eye from every direction of sky.", focus: ["eye"] }
  ],
  further: ["Why are sunsets red?", "What is Rayleigh scattering?"]
};

test("a clean scene survives normalisation", () => {
  const s = U.normalize(good);
  assert.equal(s.title, "Why the sky is blue");
  assert.equal(s.nodes.length, 3);
  assert.equal(s.links.length, 2);
  assert.deepEqual(s.notes, [], JSON.stringify(s.notes));
  assert.equal(s.steps.length, 3);
  assert.deepEqual(s.nodes[0], { id: "sun", label: "Sunlight", role: "White light, all wavelengths together", x: 60, y: 240, w: 150, h: 70 });
});

test("dropped links are reported, not hidden", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.links.push({ from: "sun", to: "nowhere", label: "bogus" });
  const s = U.normalize(raw);
  assert.equal(s.links.length, 2);
  assert.ok(s.notes.some((n) => /outside the diagram/.test(n)), JSON.stringify(s.notes));
});

test("boxes that fall off the canvas are moved back and noted", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.nodes[0].x = -500;
  raw.nodes[0].y = 9999;
  const s = U.normalize(raw);
  const n = s.nodes[0];
  assert.ok(n.x >= U.PAD, "x clamped: " + n.x);
  assert.ok(n.y + n.h <= U.CANVAS.h - U.PAD, "y clamped: " + n.y);
  assert.ok(s.notes.some((t) => /inside the canvas/.test(t)));
});

test("oversized boxes are capped to the maximum", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.nodes[1].w = 5000;
  raw.nodes[1].h = 5000;
  const s = U.normalize(raw);
  assert.ok(s.nodes[1].w <= 260);
  assert.ok(s.nodes[1].h <= 128);
});

test("duplicate ids are made unique", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.nodes[1].id = "sun";
  const s = U.normalize(raw);
  const ids = s.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
});

test("a reply with fewer than two parts is refused", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.nodes = raw.nodes.slice(0, 1);
  assert.throws(() => U.normalize(raw), /at least two parts/);
});

test("a reply with no steps is refused", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.steps = [];
  assert.throws(() => U.normalize(raw), /no usable steps/);
});

test("a step that names a missing part keeps its text and is noted", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.steps[0].focus = ["ghost"];
  const s = U.normalize(raw);
  assert.equal(s.steps[0].detail, "The sun sends every visible wavelength at once.");
  assert.deepEqual(s.steps[0].focus, []);
  assert.ok(s.notes.some((t) => /not in the diagram/.test(t)));
});

test("a clean scene scores 100", () => {
  const s = U.normalize(good);
  const r = U.integrity(s);
  assert.equal(r.score, 100, JSON.stringify(r.issues));
  assert.equal(r.grade, "clean");
  assert.deepEqual(r.issues, []);
});

test("overlapping boxes are spread apart before drawing", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.nodes[1].x = 70;
  raw.nodes[1].y = 245;
  const s = U.normalize(raw);
  assert.ok(s.notes.some((t) => /spread/.test(t)), JSON.stringify(s.notes));
  const r = U.integrity(s);
  assert.equal(r.score, 100, JSON.stringify(r.issues));
});

test("integrity still reports overlap when given one", () => {
  const s = U.normalize(good);
  s.nodes[1].x = s.nodes[0].x + 10;
  s.nodes[1].y = s.nodes[0].y + 10;
  const r = U.integrity(s);
  assert.equal(r.score, 90);
  assert.equal(r.grade, "workable");
  assert.ok(r.issues.some((t) => /overlap/.test(t)));
});

test("a part used by nothing costs 10 and is named", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.links = [{ from: "sun", to: "air", label: "enters" }];
  raw.steps = [
    { title: "one", detail: "a", focus: ["sun"] },
    { title: "two", detail: "b", focus: ["air"] }
  ];
  const r = U.integrity(U.normalize(raw));
  assert.equal(r.score, 90);
  assert.ok(r.issues.some((t) => /never appear/.test(t)));
});

test("no links at all costs 10 and is named", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.links = [];
  const r = U.integrity(U.normalize(raw));
  assert.equal(r.score, 90);
  assert.ok(r.issues.some((t) => /no links/.test(t)));
});

test("wrap respects the line budget and marks a cut", () => {
  const lines = U.wrap("Photons scatter off molecules much smaller than their wavelength", 16, 3);
  assert.equal(lines.length, 3, lines.join("|"));
  assert.ok(lines[2].endsWith("\u2026"), lines.join("|"));
  assert.ok(lines[0].length <= 16, lines[0]);
});

test("wrap keeps a short label intact on one line", () => {
  assert.deepEqual(U.wrap("Air molecules", 16, 3), ["Air molecules"]);
});

test("clip shortens on a word boundary and marks the cut", () => {
  const out = U.clip("the quick brown fox jumps over the lazy dog", 20);
  assert.ok(out.length <= 20, out);
  assert.ok(out.endsWith("\u2026"), out);
  assert.ok(!/\s\u2026$/.test(out), "no dangling space before the ellipsis");
});

test("numbers sent as strings are accepted", () => {
  const raw = JSON.parse(JSON.stringify(good));
  raw.nodes[2].x = "800";
  raw.nodes[2].y = "240";
  const s = U.normalize(raw);
  assert.equal(s.nodes[2].x, 800);
});
