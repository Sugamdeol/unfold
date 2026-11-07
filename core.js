/* Unfold - scene normalisation and integrity checks.
   The model proposes a diagram; this file decides what is allowed on the
   canvas and how trustworthy the result is. No DOM, no network: node --test
   can run all of it. */

(function (root) {
  "use strict";

  var CANVAS = { w: 1000, h: 620 };
  var PAD = 8;
  var DEFAULT_W = 158;
  var DEFAULT_H = 62;
  var MIN_W = 92;
  var MAX_W = 260;
  var MIN_H = 46;
  var MAX_H = 128;

  function slug(v, fallback) {
    var s = String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || fallback;
  }

  function num(v, fallback) {
    var n = typeof v === "string" ? Number(v.trim()) : v;
    if (typeof n !== "number" || !isFinite(n)) return fallback;
    return n;
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function clip(text, max) {
    var t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    var cut = t.slice(0, max - 1);
    var space = cut.lastIndexOf(" ");
    if (space > max * 0.6) cut = cut.slice(0, space);
    return cut.replace(/[\s,;:.]+$/, "") + "\u2026";
  }

  // A node box never leaves the canvas: x/y are top-left corners in canvas units.
  function place(x, y, w, h) {
    var width = clamp(num(w, DEFAULT_W), MIN_W, MAX_W);
    var height = clamp(num(h, DEFAULT_H), MIN_H, MAX_H);
    return {
      x: Math.round(clamp(num(x, CANVAS.w / 2), PAD, CANVAS.w - width - PAD)),
      y: Math.round(clamp(num(y, CANVAS.h / 2), PAD, CANVAS.h - height - PAD)),
      w: Math.round(width),
      h: Math.round(height)
    };
  }

  function centre(node) {
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  }

  function overlaps(a, b, pad) {
    var p = pad == null ? PAD : pad;
    return !(
      a.x + a.w + p <= b.x ||
      b.x + b.w + p <= a.x ||
      a.y + a.h + p <= b.y ||
      b.y + b.h + p <= a.y
    );
  }

  // Nudge overlapping boxes apart so nothing is drawn on top of anything else.
  // Cheap iterative separation: push along the axis with the smaller overlap.
  function separate(nodes) {
    var moved = [];
    for (var pass = 0; pass < 24; pass += 1) {
      var hit = false;
      for (var i = 0; i < nodes.length; i += 1) {
        for (var j = i + 1; j < nodes.length; j += 1) {
          var a = nodes[i], b = nodes[j];
          var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox <= -PAD || oy <= -PAD) continue;
          hit = true;
          if (ox < oy) {
            var shift = (ox + PAD + 3) / 2;
            var right = b.x + b.w < CANVAS.w - PAD ? 1 : -1;
            b.x = Math.round(clamp(b.x + shift * right, PAD, CANVAS.w - b.w - PAD));
            a.x = Math.round(clamp(a.x - shift * right, PAD, CANVAS.w - a.w - PAD));
          } else {
            var down = b.y + b.h < CANVAS.h - PAD ? 1 : -1;
            var sh = (oy + PAD + 3) / 2;
            b.y = Math.round(clamp(b.y + sh * down, PAD, CANVAS.h - b.h - PAD));
            a.y = Math.round(clamp(a.y - sh * down, PAD, CANVAS.h - a.h - PAD));
          }
          if (moved.indexOf(a.label) === -1) moved.push(a.label);
          if (moved.indexOf(b.label) === -1) moved.push(b.label);
        }
      }
      if (!hit) break;
    }
    return moved;
  }

  // Turn a raw model reply into a scene, or throw with the reason. Nothing is
  // repaired silently: dropped links and clamped boxes are recorded in notes.
  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the reply was not a JSON object");
    var title = clip(raw.title, 90);
    if (!title) throw new Error("the reply had no title");
    if (!Array.isArray(raw.nodes)) throw new Error("the reply had no nodes array");

    var notes = [];
    var seen = {};
    var nodes = [];
    raw.nodes.slice(0, 12).forEach(function (n, i) {
      if (!n || typeof n !== "object") return;
      var label = clip(n.label, 44);
      if (!label) return;
      var id = slug(n.id || label, "part-" + (i + 1));
      var base = id, k = 2;
      while (seen[id]) { id = base + "-" + k; k += 1; }
      seen[id] = true;
      var box = place(n.x, n.y, n.w, n.h);
      if (num(n.x, box.x) !== box.x || num(n.y, box.y) !== box.y) {
        notes.push("moved " + label + " back inside the canvas");
      }
      nodes.push({
        id: id,
        label: label,
        role: clip(n.role, 220),
        x: box.x, y: box.y, w: box.w, h: box.h
      });
    });
    if (nodes.length < 2) throw new Error("a diagram needs at least two parts, the reply had " + nodes.length);

    var spread = separate(nodes);
    if (spread.length) {
      notes.push("spread " + spread.length + " part(s) apart so the boxes do not overlap");
    }

    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    var links = [];
    var seenLink = {};
    (Array.isArray(raw.links) ? raw.links : []).forEach(function (l) {
      if (!l || typeof l !== "object") return;
      var from = slug(l.from, ""), to = slug(l.to, "");
      if (!byId[from] || !byId[to] || from === to) {
        if (from || to) notes.push("dropped a link that pointed outside the diagram");
        return;
      }
      var key = from + ">" + to;
      if (seenLink[key]) return;
      seenLink[key] = true;
      links.push({ from: from, to: to, label: clip(l.label, 40) });
    });

    var steps = [];
    (Array.isArray(raw.steps) ? raw.steps : []).forEach(function (s, i) {
      if (!s || typeof s !== "object") return;
      var detail = clip(s.detail, 520);
      if (!detail) return;
      var focus = (Array.isArray(s.focus) ? s.focus : []).map(function (f) {
        return slug(f, "");
      }).filter(function (f) { return !!byId[f]; });
      if (!focus.length && Array.isArray(s.focus) && s.focus.length) {
        notes.push("step " + (i + 1) + " named a part that is not in the diagram");
      }
      steps.push({
        title: clip(s.title, 70) || "Step " + (i + 1),
        detail: detail,
        focus: focus
      });
    });
    if (!steps.length) throw new Error("the reply had no usable steps");

    var further = (Array.isArray(raw.further) ? raw.further : []).map(function (q) {
      return clip(q, 110);
    }).filter(Boolean).slice(0, 4);

    return {
      title: title,
      blurb: clip(raw.blurb, 300),
      nodes: nodes,
      links: links,
      steps: steps,
      further: further,
      notes: notes
    };
  }

  // How much of the proposal actually holds together. 100 is a clean diagram.
  function integrity(scene) {
    var issues = [];
    var score = 100;
    var nodes = scene.nodes || [];
    var links = scene.links || [];
    var steps = scene.steps || [];

    // Repairs the normaliser had to make are part of the figure's quality.
    var notes = scene.notes || [];
    if (notes.length) {
      issues.push(notes.length + " correction(s) before drawing: " + notes.join("; "));
    }

    var overlapsFound = [];
    for (var i = 0; i < nodes.length; i += 1) {
      for (var j = i + 1; j < nodes.length; j += 1) {
        if (overlaps(nodes[i], nodes[j], PAD)) overlapsFound.push([nodes[i].label, nodes[j].label]);
      }
    }
    if (overlapsFound.length) {
      score -= Math.min(40, overlapsFound.length * 10);
      issues.push(overlapsFound.length + " pair(s) of parts overlap: " + overlapsFound.map(function (p) { return p.join(" / "); }).join("; "));
    }

    var touched = {};
    links.forEach(function (l) { touched[l.from] = true; touched[l.to] = true; });
    steps.forEach(function (s) { s.focus.forEach(function (f) { touched[f] = true; }); });
    var lonely = nodes.filter(function (n) { return !touched[n.id]; });
    if (lonely.length) {
      score -= Math.min(30, lonely.length * 10);
      issues.push(lonely.length + " part(s) never appear in a step or a link: " + lonely.map(function (n) { return n.label; }).join(", "));
    }

    var empty = steps.filter(function (s) { return !s.focus.length; });
    if (empty.length) {
      score -= Math.min(20, empty.length * 5);
      issues.push(empty.length + " step(s) point at no part");
    }

    if (!links.length) {
      score -= 10;
      issues.push("no links between parts");
    }

    nodes.forEach(function (n) {
      if (n.x < 0 || n.y < 0 || n.x + n.w > CANVAS.w || n.y + n.h > CANVAS.h) {
        score -= 10;
        issues.push(n.label + " sits outside the canvas");
      }
    });

    score = clamp(Math.round(score), 0, 100);
    return {
      score: score,
      issues: issues,
      grade: issues.length === 0 ? "clean" : score >= 80 ? "workable" : "rough"
    };
  }

  // Wrap a label into at most `max` lines of roughly `per` characters.
  function wrap(label, per, max) {
    var words = String(label || "").split(/\s+/).filter(Boolean);
    var lines = [];
    var line = "";
    words.forEach(function (w) {
      if (!line.length) { line = w; return; }
      if ((line + " " + w).length <= per) { line += " " + w; return; }
      lines.push(line);
      line = w;
    });
    if (line) lines.push(line);
    if (lines.length > max) {
      var kept = lines.slice(0, max);
      kept[max - 1] = clip(kept[max - 1] + " " + lines.slice(max).join(" "), per + 2);
      return kept;
    }
    return lines;
  }

  var api = {
    CANVAS: CANVAS,
    PAD: PAD,
    slug: slug,
    clip: clip,
    place: place,
    centre: centre,
    overlaps: overlaps,
    normalize: normalize,
    integrity: integrity,
    wrap: wrap
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.UNFOLD = api;
})(typeof window !== "undefined" ? window : globalThis);
