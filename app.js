/* Unfold - a science topic drawn as a diagram you can walk through.
   One model call proposes the parts, links and steps; core.js decides what is
   allowed on the canvas; this file draws it and answers follow-up questions.
   No build step, no dependencies, no server. Visitors pay with their own Pollen. */

(function () {
  "use strict";

  var U = window.UNFOLD;

  var CFG = {
    clientId: "pk_xvhcmpgSz2sCxeFp",
    authEndpoint: "https://enter.pollinations.ai/authorize",
    tokenEndpoint: "https://enter.pollinations.ai/api/oauth/token",
    userinfoEndpoint: "https://enter.pollinations.ai/api/oauth/userinfo",
    chatEndpoint: "https://gen.pollinations.ai/v1/chat/completions",
    scope: "profile usage",
    budget: 4,
    expiryDays: 7
  };

  var MODEL = "openai/gpt-5.4-nano";

  var SYSTEM = [
    "You draw explanations. Given a science topic you return ONE JSON object that describes a diagram and the steps that read it.",
    "",
    "The canvas is 1000 wide and 620 tall with the origin at the top left. A part is a box: {\"id\", \"label\", \"role\", \"x\", \"y\", \"w\", \"h\"} where x,y is the top left corner. Use w between 130 and 230 and h between 56 and 104. Keep every box fully inside the canvas and leave at least 20 units of empty space between boxes. \"label\" is 1 to 4 words; \"role\" is a plain-English phrase of at most 8 words, no underscores, no ids.",
    "",
    "A link is {\"from\", \"to\", \"label\"} and uses part ids. A step is {\"title\", \"detail\", \"focus\"} where focus lists the part ids the step is about and detail is two or three sentences of real explanation, at least 110 characters.",
    "",
    "Reply shape:",
    "{\"title\": \"short title\", \"blurb\": \"one sentence\", \"nodes\": [...], \"links\": [...], \"steps\": [...], \"further\": [\"a deeper question\"]}",
    "",
    "Rules:",
    "1. Four to seven parts. Every part is used by at least one step focus or one link. Nothing decorative.",
    "2. Three to six steps in reading order. Each step teaches something specific and true, never restates its title.",
    "3. Three to eight links, each labelled with the verb of the interaction (\"scatters\", \"raises\", \"inhibits\").",
    "4. Two or three further questions a curious reader would ask next.",
    "5. Be scientifically accurate. If the topic has a common misconception, correct it in a step.",
    "6. Lay the diagram out as a flow, left to right or top to bottom, so the arrows do not cross.",
    "7. Return JSON only. No prose, no markdown fence."
  ].join("\n");

  var ASK_SYSTEM = [
    "You are answering one follow-up question about one part of a diagram.",
    "Answer in at most 70 words of plain prose. No lists, no headings, no preamble.",
    "Be concrete and accurate. If the diagram does not cover what was asked, say so in one clause and answer anyway."
  ].join("\n");

  var $ = function (s) { return document.querySelector(s); };
  var SVGNS = "http://www.w3.org/2000/svg";

  var S = {
    token: sessionStorage.getItem("unfold.token") || null,
    scene: null,
    step: 0,
    selected: null,
    calls: 0,
    busy: false
  };

  /* ------------------------------------------------------------------ auth */

  function pageUrl() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, "");
  }
  function b64url(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function rnd(n) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var b = new Uint8Array(n), out = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < n; i += 1) out += alphabet[b[i] % alphabet.length];
    return out;
  }
  function signIn() {
    var verifier = rnd(64), state = rnd(24);
    sessionStorage.setItem("unfold.verifier", verifier);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url).then(function (ch) {
      var p = new URLSearchParams({
        response_type: "code",
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        scope: CFG.scope,
        budget: String(CFG.budget),
        models: "text",
        expiry: String(CFG.expiryDays),
        state: state,
        code_challenge: ch,
        code_challenge_method: "S256"
      });
      window.location.assign(CFG.authEndpoint + "?" + p.toString());
    });
  }
  function finishSignIn() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code"), err = params.get("error");
    if (!code && !err) return Promise.resolve(false);
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", pageUrl());
    if (err) {
      setStatus("Sign in failed: " + err + " " + (params.get("error_description") || ""), "err");
      return Promise.resolve(true);
    }
    var verifier = sessionStorage.getItem("unfold.verifier");
    if (!verifier) {
      setStatus("Sign in could not finish because this tab lost its verifier. Sign in again.", "err");
      return Promise.resolve(true);
    }
    setStatus("Finishing sign in...", "");
    return fetch(CFG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        code_verifier: verifier
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d.access_token) throw new Error((d && (d.error_description || d.error)) || ("HTTP " + r.status));
        S.token = d.access_token;
        sessionStorage.setItem("unfold.token", S.token);
        sessionStorage.removeItem("unfold.verifier");
      });
    }).then(function () {
      setStatus("Signed in. Your own Pollen pays for each drawing.", "ok");
      return loadUser().then(function () { return true; });
    }).catch(function (e) {
      setStatus("Sign in failed: " + (e && e.message ? e.message : "unknown error"), "err");
      return true;
    });
  }
  function loadUser() {
    if (!S.token) {
      $("#who").textContent = "Not signed in";
      $("#signBtn").textContent = "Sign in with Pollen";
      return Promise.resolve();
    }
    return fetch(CFG.userinfoEndpoint, { headers: { Authorization: "Bearer " + S.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (u) {
        var name = (u && (u.name || u.githubUsername || u.username || u.email)) || "Pollen account";
        $("#who").textContent = name;
        $("#signBtn").textContent = "Sign out";
      });
  }

  /* ----------------------------------------------------------------- model */

  function setStatus(msg, kind) {
    var el = $("#status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  function ask(system, user, maxTokens) {
    var body = {
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: maxTokens || 2400,
      reasoning_effort: "low"
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 90000);
    return fetch(CFG.chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.token },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      return r.text().then(function (text) {
        clearTimeout(timer);
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!r.ok) {
          var m = (data && data.error && (data.error.message || data.error)) || text || ("HTTP " + r.status);
          var e2 = new Error(String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 200));
          e2.status = r.status;
          throw e2;
        }
        S.calls += 1;
        $("#cost").textContent = S.calls + (S.calls === 1 ? " model call" : " model calls");
        var ch = data && data.choices && data.choices[0];
        var content = ch && ch.message ? (ch.message.content || "") : "";
        if (Array.isArray(content)) {
          content = content.map(function (p) { return typeof p === "string" ? p : (p && p.text) || ""; }).join(" ");
        }
        return String(content || "");
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") {
        var t = new Error("the model did not answer within 90 seconds");
        t.status = 0;
        throw t;
      }
      throw e;
    });
  }

  function stripJson(text) {
    var t = String(text || "").trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    var start = t.indexOf("{"), end = t.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("the reply had no JSON object in it");
    return t.slice(start, end + 1);
  }

  /* ---------------------------------------------------------------- render */

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function edgeGeometry(a, b) {
    var ca = U.centre(a), cb = U.centre(b);
    var dx = cb.x - ca.x, dy = cb.y - ca.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    function reach(node) {
      var tx = ux === 0 ? 1e9 : Math.abs((node.w / 2) / ux);
      var ty = uy === 0 ? 1e9 : Math.abs((node.h / 2) / uy);
      return Math.min(tx, ty);
    }
    var ra = reach(a), rb = reach(b);
    return {
      x1: ca.x + ux * ra, y1: ca.y + uy * ra,
      x2: cb.x - ux * (rb + 8), y2: cb.y - uy * (rb + 8),
      ux: ux, uy: uy
    };
  }

  // A link label must never land on top of a box. Labels are placed in canvas
  // units with an estimated text width: first on the connector, then above the
  // two boxes, then below them. A label with nowhere to go is hidden, because a
  // missing word beats an unreadable one.
  var CHAR_W = 5.7;

  function placeLabels() {
    var boxes = S.scene.nodes;
    function clash(rect) {
      return boxes.some(function (b) {
        return !(rect.x + rect.w <= b.x || b.x + b.w <= rect.x || rect.y + rect.h <= b.y || b.y + b.h <= rect.y);
      });
    }
    var hidden = 0;
    Array.prototype.forEach.call(document.querySelectorAll("#edges text"), function (t) {
      var g = t.__geo, a = g.a, b = g.b, label = t.textContent;
      var w = label.length * CHAR_W + 6, h = 12;
      var midX = (g.x1 + g.x2) / 2, midY = (g.y1 + g.y2) / 2;
      var topY = Math.min(a.y, b.y) - 9;
      var botY = Math.max(a.y + a.h, b.y + b.h) + 15;
      var spots = [
        [midX, midY - 7], [midX, midY + 13],
        [midX, topY], [midX, botY],
        [g.x1 + (g.x2 - g.x1) * 0.3, topY], [g.x1 + (g.x2 - g.x1) * 0.7, topY]
      ];
      for (var i = 0; i < spots.length; i += 1) {
        var cx = spots[i][0], cy = spots[i][1];
        var rect = { x: cx - w / 2, y: cy - h, w: w, h: h };
        if (rect.x < 0 || rect.x + rect.w > U.CANVAS.w || rect.y < 0) continue;
        if (!clash(rect)) {
          t.setAttribute("x", cx.toFixed(1));
          t.setAttribute("y", cy.toFixed(1));
          return;
        }
      }
      t.style.display = "none";
      hidden += 1;
    });
    return hidden;
  }

  function focusSet() {
    var scene = S.scene;
    if (!scene) return null;
    if (S.selected) {
      var one = {};
      one[S.selected] = true;
      scene.links.forEach(function (l) {
        if (l.from === S.selected) one[l.to] = true;
        if (l.to === S.selected) one[l.from] = true;
      });
      return { nodes: one, links: null };
    }
    var st = scene.steps[S.step];
    if (!st) return null;
    var nodes = {};
    st.focus.forEach(function (f) { nodes[f] = true; });
    var links = {};
    scene.links.forEach(function (l) {
      if (nodes[l.from] && nodes[l.to]) links[l.from + ">" + l.to] = true;
    });
    return { nodes: nodes, links: links };
  }

  function render() {
    var scene = S.scene;
    var gEdges = $("#edges"), gNodes = $("#nodes");
    gEdges.textContent = "";
    gNodes.textContent = "";
    if (!scene) return;

    var byId = {};
    scene.nodes.forEach(function (n) { byId[n.id] = n; });
    var f = focusSet();
    var anyFocus = f && Object.keys(f.nodes).length > 0;

    scene.links.forEach(function (l) {
      var a = byId[l.from], b = byId[l.to];
      if (!a || !b) return;
      var g = edgeGeometry(a, b);
      var hot = f && f.links && f.links[l.from + ">" + l.to];
      var cold = anyFocus && !hot;
      gEdges.appendChild(svgEl("line", {
        x1: g.x1.toFixed(1), y1: g.y1.toFixed(1), x2: g.x2.toFixed(1), y2: g.y2.toFixed(1),
        "class": "edge" + (hot ? " hot" : cold ? " cold" : ""),
        "marker-end": "url(#" + (hot ? "arrowhot" : "arrow") + ")"
      }));
      if (l.label) {
        var t = svgEl("text", {
          x: ((g.x1 + g.x2) / 2).toFixed(1), y: ((g.y1 + g.y2) / 2).toFixed(1),
          "text-anchor": "middle", "class": "elab" + (cold ? " cold" : "")
        });
        t.textContent = l.label;
        g.a = a; g.b = b;
        t.__geo = g;
        gEdges.appendChild(t);
      }
    });

    scene.nodes.forEach(function (n) {
      var hot = f && f.nodes[n.id];
      var cold = anyFocus && !hot;
      var g = svgEl("g", { style: "cursor:pointer" });
      g.appendChild(svgEl("rect", {
        x: n.x, y: n.y, width: n.w, height: n.h, rx: 6,
        "class": "nbox" + (hot ? " hot" : cold ? " cold" : "")
      }));
      var labelLines = U.wrap(n.label, Math.max(12, Math.floor((n.w - 18) / 7.1)), 2);
      var hasRole = !!n.role;
      var blockH = labelLines.length * 17 + (hasRole ? 15 : 0);
      var top = n.y + (n.h - blockH) / 2 + 12;
      labelLines.forEach(function (ln, i) {
        var t = svgEl("text", {
          x: n.x + n.w / 2, y: top + i * 17, "text-anchor": "middle",
          "class": "nlab" + (cold ? " cold" : "")
        });
        t.textContent = ln;
        g.appendChild(t);
      });
      if (hasRole) {
        var rl = U.wrap(n.role, Math.max(16, Math.floor((n.w - 14) / 5.1)), 1)[0] || "";
        var rt = svgEl("text", {
          x: n.x + n.w / 2, y: top + labelLines.length * 17, "text-anchor": "middle",
          "class": "nrole" + (cold ? " cold" : "")
        });
        rt.textContent = rl;
        g.appendChild(rt);
      }
      g.addEventListener("click", function () { selectNode(n.id); });
      gNodes.appendChild(g);
    });

    $("#figtitle").textContent = scene.title;
    $("#figmeta").textContent = scene.nodes.length + " parts, " + scene.links.length + " links";
    $("#hint").style.display = "none";
    $("#svgtitle").textContent = scene.title;
    placeLabels();

    renderSteps();
    renderIntegrity();
    renderFurther();
    updateAsk();
  }

  function renderSteps() {
    var scene = S.scene;
    var dots = $("#dots");
    dots.textContent = "";
    scene.steps.forEach(function (s, i) {
      var b = document.createElement("button");
      b.className = "dot" + (i === S.step ? " on" : "");
      b.textContent = String(i + 1);
      b.title = s.title;
      b.addEventListener("click", function () { goStep(i); });
      dots.appendChild(b);
    });
    $("#stepmeta").textContent = (S.step + 1) + " / " + scene.steps.length;
    var cur = scene.steps[S.step];
    var box = $("#steptext");
    box.textContent = "";
    if (cur) {
      var strong = document.createElement("b");
      strong.textContent = cur.title + ". ";
      box.appendChild(strong);
      box.appendChild(document.createTextNode(cur.detail));
      if (!S.selected && cur.focus.length) {
        var names = cur.focus.map(function (id) {
          var n = scene.nodes.filter(function (x) { return x.id === id; })[0];
          return n ? n.label : id;
        });
        var foot = document.createElement("div");
        foot.className = "micro";
        foot.style.marginTop = "8px";
        foot.textContent = "Touching " + names.join(" and ");
        box.appendChild(foot);
      }
    }
  }

  function renderIntegrity() {
    var r = U.integrity(S.scene);
    $("#score").textContent = r.score + " / 100, " + r.grade;
    var fill = $("#barfill");
    fill.style.width = r.score + "%";
    fill.style.background = r.score >= 90 ? "var(--green)" : r.score >= 70 ? "#c08a2a" : "var(--rust)";
    var ul = $("#issues");
    ul.textContent = "";
    r.issues.forEach(function (t) {
      var li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    });
  }

  function renderFurther() {
    var box = $("#further");
    box.textContent = "";
    var list = S.scene.further || [];
    if (!list.length) {
      var p = document.createElement("div");
      p.className = "micro";
      p.textContent = "the model offered none";
      box.appendChild(p);
      return;
    }
    list.forEach(function (q) {
      var b = document.createElement("button");
      b.textContent = q;
      b.addEventListener("click", function () {
        $("#topic").value = q;
        build();
      });
      box.appendChild(b);
    });
  }

  function updateAsk() {
    var node = null;
    if (S.scene && S.selected) {
      node = S.scene.nodes.filter(function (n) { return n.id === S.selected; })[0] || null;
    }
    $("#askhead").textContent = node ? "Ask about " + node.label : "Ask about a part";
    $("#q").placeholder = node ? "what happens if this changes" : "select a part in the figure first";
    $("#q").disabled = !node;
    $("#askBtn").disabled = !node || S.busy;
    $("#panelTitle").textContent = node ? node.label : "Reading it";
    if (!node) $("#answer").textContent = "";
  }

  function goStep(i) {
    if (!S.scene) return;
    S.step = Math.max(0, Math.min(S.scene.steps.length - 1, i));
    S.selected = null;
    render();
  }

  function selectNode(id) {
    S.selected = S.selected === id ? null : id;
    if (S.selected && S.scene) {
      var node = S.scene.nodes.filter(function (n) { return n.id === S.selected; })[0];
      if (node) {
        $("#answer").textContent = node.role || "";
        $("#q").value = "";
      }
    }
    render();
  }

  /* ----------------------------------------------------------------- build */

  function build() {
    var topic = ($("#topic").value || "").trim();
    if (!topic) {
      setStatus("Type a topic first, or pick one of the examples.", "err");
      return Promise.resolve();
    }
    if (!S.token) {
      setStatus("Sign in with Pollinations, or use your own key, so your own Pollen pays.", "err");
      return Promise.resolve();
    }
    if (S.busy) return Promise.resolve();
    S.busy = true;
    $("#buildBtn").disabled = true;
    $("#buildBtn").textContent = "Drawing...";
    setStatus("Laying out " + topic + "...", "");
    updateAsk();

    var level = $("#level").value;
    var user = "Topic: " + topic + "\nWrite it for " + level + ".\n\nReturn the JSON object that explains this topic.";

    return ask(SYSTEM, user, 2600)
      .then(function (text) {
        var scene = U.normalize(JSON.parse(stripJson(text)));
        S.scene = scene;
        S.step = 0;
        S.selected = null;
        $("#answer").textContent = "";
        render();
        var r = U.integrity(scene);
        if (scene.notes.length) {
          setStatus("Drawn with " + scene.notes.length + " correction(s): " + scene.notes.join("; "), "");
        } else {
          setStatus("Drawn. " + scene.steps.length + " steps, integrity " + r.score + ".", "ok");
        }
      })
      .catch(function (e) {
        var msg = e && e.message ? e.message : "unknown error";
        if (e && e.status === 401) msg = "the key was rejected, sign in again";
        if (e && e.status === 402) msg = "that request costs more than your balance allows";
        if (e && e.status === 429) msg = "the provider is rate limiting, wait a moment";
        setStatus("Could not draw that: " + msg, "err");
      })
      .then(function () {
        S.busy = false;
        $("#buildBtn").disabled = false;
        $("#buildBtn").textContent = "Unfold it";
        updateAsk();
      });
  }

  function askAboutPart() {
    var node = null;
    if (S.scene && S.selected) node = S.scene.nodes.filter(function (n) { return n.id === S.selected; })[0];
    if (!node) return Promise.resolve();
    if (!S.token) {
      setStatus("Sign in first, so your own Pollen pays.", "err");
      return Promise.resolve();
    }
    if (S.busy) return Promise.resolve();
    var q = ($("#q").value || "").trim() || "What is this, and why does it matter here?";
    S.busy = true;
    $("#askBtn").disabled = true;
    $("#answer").textContent = "Thinking about " + node.label + "...";

    var parts = S.scene.nodes.map(function (n) { return "- " + n.label + ": " + n.role; }).join("\n");
    var user = "Diagram: " + S.scene.title + "\n" + S.scene.blurb + "\nParts:\n" + parts +
      "\n\nThe reader selected \"" + node.label + "\" and asks: " + q;

    return ask(ASK_SYSTEM, user, 320)
      .then(function (text) {
        $("#answer").textContent = String(text || "").trim();
      })
      .catch(function (e) {
        $("#answer").textContent = "Could not answer: " + (e && e.message ? e.message : "unknown error");
      })
      .then(function () {
        S.busy = false;
        updateAsk();
      });
  }

  /* ---------------------------------------------------------------- wiring */

  function init() {
    $("#buildBtn").addEventListener("click", build);
    $("#topic").addEventListener("keydown", function (e) { if (e.key === "Enter") build(); });
    $("#next").addEventListener("click", function () { goStep(S.step + 1); });
    $("#prev").addEventListener("click", function () { goStep(S.step - 1); });
    $("#askBtn").addEventListener("click", askAboutPart);
    $("#q").addEventListener("keydown", function (e) { if (e.key === "Enter") askAboutPart(); });
    $("#signBtn").addEventListener("click", function () {
      if (S.token) {
        S.token = null;
        sessionStorage.removeItem("unfold.token");
        loadUser();
        setStatus("Signed out. The drawing stays.", "");
        return;
      }
      signIn();
    });
    $("#keyBtn").addEventListener("click", function () { $("#keyrow").classList.toggle("on"); });
    $("#keyUse").addEventListener("click", function () {
      var k = ($("#skey").value || "").trim();
      if (!/^sk_/.test(k)) {
        setStatus("A secret key starts with sk_. An app key (pk_) cannot make model calls.", "err");
        return;
      }
      S.token = k;
      sessionStorage.setItem("unfold.token", k);
      $("#skey").value = "";
      $("#keyrow").classList.remove("on");
      setStatus("Key set for this tab. Your own Pollen pays.", "ok");
      loadUser();
    });
    Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (b) {
      b.addEventListener("click", function () {
        $("#topic").value = b.textContent;
        build();
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "ArrowRight") goStep(S.step + 1);
      if (e.key === "ArrowLeft") goStep(S.step - 1);
    });
    updateAsk();
    finishSignIn().then(loadUser);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
