/* Phantom Bandwidth — generative lo-fi engine.
   Self-contained, no deps, no modules. Include via:
     <script src="lofi-engine.js" defer></script>
   then drive it through window.LofiEngine (start/stop/skip/setVolume/...).

   Hybrid: drums + vinyl crackle + optional vocal chops are samples
   (auto-discovered by naming convention under ./lofi/); pads, keys,
   bass, lead, hiss/crackle backup, wow/flutter, reverb and the sidechain
   duck are synthesized. Each "track" runs ~2-5 min then transitions to a
   fresh generative config so it reads like a curated mix.

   On by default as ambient site music (opt-in + volume persist in
   localStorage); browser autoplay policy is respected so audio only resumes
   after a real user gesture. Hosts that drive playback themselves (e.g.
   Roomtone's radio/vinyl item) call setAutoplay(false) + play()/pause(),
   which do NOT touch the persisted site-music preference. */
(function () {
  "use strict";
  if (window.LofiEngine) return;

  var STORE_KEY = "phantombw.lofi";
  var SAMPLE_BASE = "lofi";
  var AHEAD = 0.12;          // scheduler lookahead (s)
  var TICK = 25;             // scheduler poll (ms)

  // ---- persisted prefs -----------------------------------------------------
  var prefs = { vol: 0.5, enabled: true };
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      var p = JSON.parse(raw);
      if (typeof p.vol === "number") prefs.vol = Math.min(1, Math.max(0, p.vol));
      if (typeof p.enabled === "boolean") prefs.enabled = p.enabled;
    }
  } catch (e) {}
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  // ---- audio context + master chain ---------------------------------------
  var ctx = null, ready = false;
  var master, toneLP, mixBus, musicDuck, drumsBus, texBus, reverb, revReturn;
  var wowLFO, wowDepth, flutLFO, flutDepth;

  function mkContext() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    buildGraph();
    loadSamples();
    return ctx;
  }

  function softCurve() {
    var n = 1024, c = new Float32Array(n), k = 1.1;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / Math.tanh(k);   // gentle warm saturation
    }
    return c;
  }

  function impulse(seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return b;
  }

  function buildGraph() {
    master = ctx.createGain();  master.gain.value = prefs.vol;

    var sat = ctx.createWaveShaper();
    sat.curve = softCurve(); sat.oversample = "2x";

    toneLP = ctx.createBiquadFilter();
    toneLP.type = "lowpass"; toneLP.frequency.value = 8200; toneLP.Q.value = 0.4;

    mixBus = ctx.createGain(); mixBus.gain.value = 1;

    // music (pads/keys/bass/lead/chops) ducks under the kick; drums + texture don't
    musicDuck = ctx.createGain(); musicDuck.gain.value = 1;
    drumsBus  = ctx.createGain(); drumsBus.gain.value = 0.62;
    texBus    = ctx.createGain(); texBus.gain.value = 0.34;

    reverb = ctx.createConvolver(); reverb.buffer = impulse(2.4, 2.6);
    revReturn = ctx.createGain(); revReturn.gain.value = 0.34;

    // headroom before the saturator so the tanh stays warm, not crushed —
    // then a gentle limiter catches stray peaks instead of clipping the DAC
    var trim = ctx.createGain(); trim.gain.value = 0.30;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 12;
    comp.attack.value = 0.003; comp.release.value = 0.20;

    musicDuck.connect(mixBus);
    drumsBus.connect(mixBus);
    texBus.connect(mixBus);
    reverb.connect(revReturn).connect(mixBus);
    mixBus.connect(trim).connect(sat).connect(toneLP)
          .connect(comp).connect(master).connect(ctx.destination);

    // shared wow (slow pitch drift) + flutter (fast shallow) → osc.detune
    wowLFO = ctx.createOscillator(); wowLFO.type = "sine"; wowLFO.frequency.value = 0.27;
    wowDepth = ctx.createGain(); wowDepth.gain.value = 4;        // cents
    wowLFO.connect(wowDepth); wowLFO.start();
    flutLFO = ctx.createOscillator(); flutLFO.type = "sine"; flutLFO.frequency.value = 5.3;
    flutDepth = ctx.createGain(); flutDepth.gain.value = 1.1;
    flutLFO.connect(flutDepth); flutLFO.start();

    ready = true;
  }

  function wowWire(osc) { wowDepth.connect(osc.detune); flutDepth.connect(osc.detune); }

  // ---- sample library (auto-discovered by convention) ---------------------
  // Adding more files later (kick_04.wav, chop_12.wav, ...) needs no code change.
  var LIB = { kick: [], snare: [], rim: [], hatC: [], hatO: [], perc: [],
              shaker: [], vinyl: [], hiss: [], chop: [] };
  var FAMILIES = [
    ["kick",   "drums",   "kick"],
    ["snare",  "drums",   "snare"],
    ["rim",    "drums",   "rim"],
    ["hatC",   "drums",   "hat_closed"],
    ["hatO",   "drums",   "hat_open"],
    ["perc",   "drums",   "perc"],
    ["shaker", "drums",   "shaker"],
    ["vinyl",  "texture", "vinyl"],
    ["hiss",   "texture", "tape_hiss"],
    ["chop",   "chops",   "chop"]
  ];
  var samplesLoaded = false;

  function decode(ab) {
    return new Promise(function (res, rej) {
      var p = ctx.decodeAudioData(ab, res, rej);   // Safari uses the callback form
      if (p && p.then) p.then(res, rej);
    });
  }

  // short one-shots stay .wav; long loops/ambience are .mp3 (smaller) — the
  // engine accepts either, so the naming convention still "just works".
  var EXTS = [".wav", ".mp3"];
  function loadFamily(key, dir, prefix) {
    var i = 1;
    function tryExt(ei) {
      if (ei >= EXTS.length) return Promise.resolve(false);
      var nn = (i < 10 ? "0" : "") + i;
      var url = SAMPLE_BASE + "/" + dir + "/" + prefix + "_" + nn + EXTS[ei];
      return fetch(url).then(function (r) {
        if (!r.ok) return tryExt(ei + 1);
        return r.arrayBuffer().then(decode).then(function (buf) {
          LIB[key].push(buf); return true;
        });
      }).catch(function () { return tryExt(ei + 1); });
    }
    function next() {
      return tryExt(0).then(function (found) {
        if (!found) return null;           // no file at this index → family ends
        i++; return next();
      });
    }
    return next();
  }

  function loadSamples() {
    Promise.all(FAMILIES.map(function (f) { return loadFamily(f[0], f[1], f[2]); }))
      .then(function () { samplesLoaded = true; });
  }

  // ---- music theory --------------------------------------------------------
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  var SCALES = {
    aeolian:  [0, 2, 3, 5, 7, 8, 10],
    dorian:   [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],   // dark, Spanish-tinged b2
    harmonic: [0, 2, 3, 5, 7, 8, 11]    // jazzy raised-7th tension
  };
  var SCALE_NAMES = ["aeolian", "dorian", "phrygian", "harmonic"];
  // progressions as 0-based scale degrees (minor-leaning lo-fi staples)
  var PROGS = [
    [0, 3, 6, 2],   // i  iv VII III
    [0, 5, 2, 6],   // i  VI III VII
    [1, 4, 0, 0],   // ii V  i   i
    [0, 4, 5, 3],   // i  v  VI  iv
    [0, 2, 3, 5],   // i  III iv VI
    [0, 6, 5, 4],   // i  VII VI v
    [0, 3, 4, 0],   // i  iv v  i
    [5, 1, 4, 0],   // VI ii V  i
    [0, 2, 5, 4]    // i  III VI v
  ];
  var LEADS = ["rhodes", "guitar", "glock", "vocal"];

  // diatonic 7th (sometimes add-9 / sus) voicing around a center octave
  function chordMidi(scale, rootMidi, degree, color) {
    var sc = scale, n = sc.length;
    function deg(d) {
      var oct = Math.floor(d / n), idx = ((d % n) + n) % n;
      return rootMidi + sc[idx] + 12 * oct;
    }
    var third = color === "sus" ? deg(degree + 3) : deg(degree + 2);
    var notes = [deg(degree), third, deg(degree + 4), deg(degree + 6)];
    if (color === "add9") notes.push(deg(degree + 8));
    return notes;
  }

  // ---- per-track generative config ----------------------------------------
  var cfg = null;
  // remember the last track so the next one is audibly different, not a reroll
  // that happens to land on the same key/scale/lead/progression.
  var prevTrack = { scale: "", progIdx: -1, lead: "", root: -1 };
  function pickDiff(arr, prev) {
    if (arr.length < 2) return arr[0];
    var v, i = 0;
    do { v = arr[(Math.random() * arr.length) | 0]; i++; }
    while (v === prev && i < 8);
    return v;
  }
  function newConfig() {
    var bpm = 68 + Math.floor(Math.random() * 25);          // 68-92
    var scaleName = pickDiff(SCALE_NAMES, prevTrack.scale);
    var root;
    do { root = 43 + Math.floor(Math.random() * 11); }      // F2..E3 region
    while (Math.abs(root - prevTrack.root) < 2 && Math.random() < 0.85);
    var progIdx;
    do { progIdx = (Math.random() * PROGS.length) | 0; }
    while (progIdx === prevTrack.progIdx && PROGS.length > 1);
    var lead = pickDiff(LEADS, prevTrack.lead);
    var barDur = (60 / bpm) * 4;
    var barsPerChord = Math.random() < 0.5 ? 1 : 2;
    var trackSec = 120 + Math.random() * 180;               // 2-5 min
    var totalBars = Math.max(32, Math.round(trackSec / barDur));
    prevTrack = { scale: scaleName, progIdx: progIdx, lead: lead, root: root };
    return {
      bpm: bpm, scale: SCALES[scaleName], scaleName: scaleName,
      root: root, prog: PROGS[progIdx],
      barDur: barDur, barsPerChord: barsPerChord,
      totalBars: totalBars, transBars: 4,
      lead: lead,
      kickPat: (Math.random() * 3) | 0,
      swing: 0.54 + Math.random() * 0.09,                   // 0.54-0.63
      // per-track timbre macros — these are what make each track its own vibe
      toneHz: 5200 + Math.random() * 3600,                  // master warmth 5.2-8.8k
      revAmt: 0.22 + Math.random() * 0.22,                  // reverb depth 0.22-0.44
      padHz:  1250 + Math.random() * 1050,                  // pad colour 1.25-2.3k
      dens:   0.78 + Math.random() * 0.42,                  // busyness 0.78-1.20
      vinylIdx: LIB.vinyl.length ? (Math.random() * LIB.vinyl.length) | 0 : -1,
      bar: 0
    };
  }
  // push this track's tone/reverb macros onto the shared chain (smoothed so
  // the change rides in over the seam rather than clicking)
  function applyTrack() {
    if (!ctx || !toneLP || !revReturn || !cfg) return;
    var t = ctx.currentTime;
    toneLP.frequency.setTargetAtTime(cfg.toneHz, t, 0.3);
    revReturn.gain.setTargetAtTime(cfg.revAmt, t, 0.3);
  }

  // --- track-change notification (host shows a "now playing" caption) ---
  var onTrackCb = null;
  function trackInfo() {
    if (!cfg) return null;
    return { lead: cfg.lead, bpm: cfg.bpm, scale: cfg.scaleName,
             label: cfg.lead + " · " + cfg.bpm + " bpm" };
  }
  function fireTrack() {
    if (onTrackCb) { try { onTrackCb(trackInfo()); } catch (e) {} }
  }

  // ---- voices --------------------------------------------------------------
  function adsr(param, t, peak, a, d, s, susT, r) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak * s), t + a + d);
    param.setValueAtTime(Math.max(0.0002, peak * s), t + a + d + susT);
    param.exponentialRampToValueAtTime(0.0001, t + a + d + susT + r);
  }

  function sendReverb(node, amt) {
    var s = ctx.createGain(); s.gain.value = amt;
    node.connect(s); s.connect(reverb);
  }

  function pad(freqs, t, dur) {
    var g = ctx.createGain(); g.gain.value = 0.0001;
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = (cfg && cfg.padHz) || 1700; lp.Q.value = 0.3;
    g.connect(lp).connect(musicDuck);
    sendReverb(g, 0.45);
    adsr(g.gain, t, 0.10, 0.9, 0.6, 0.7, dur, 1.1);
    freqs.forEach(function (f, k) {
      var o1 = ctx.createOscillator(); o1.type = "sawtooth";
      var o2 = ctx.createOscillator(); o2.type = "triangle";
      o1.frequency.value = f; o2.frequency.value = f;
      o1.detune.value = -6 + k; o2.detune.value = 7 - k;
      wowWire(o1); wowWire(o2);
      o1.connect(g); o2.connect(g);
      o1.start(t); o2.start(t);
      o1.stop(t + dur + 1.4); o2.stop(t + dur + 1.4);
    });
  }

  function rhodes(f, t, dur) {
    var car = ctx.createOscillator(); car.type = "sine"; car.frequency.value = f;
    var mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = f * 2;
    var mg = ctx.createGain(); mg.gain.value = f * 1.4;
    mod.connect(mg).connect(car.frequency);
    var g = ctx.createGain(); g.gain.value = 0.0001;
    var trem = ctx.createOscillator(); trem.type = "sine"; trem.frequency.value = 5.2;
    var td = ctx.createGain(); td.gain.value = 0.05;
    trem.connect(td).connect(g.gain);
    wowWire(car);
    car.connect(g).connect(musicDuck);
    sendReverb(g, 0.3);
    adsr(g.gain, t, 0.22, 0.005, 0.5, 0.35, dur, 0.5);
    car.start(t); mod.start(t); trem.start(t);
    var e = t + dur + 0.7;
    car.stop(e); mod.stop(e); trem.stop(e);
  }

  function glock(f, t) {
    var g = ctx.createGain(); g.gain.value = 0.0001;
    g.connect(musicDuck); sendReverb(g, 0.5);
    [[1, 0.5], [3.01, 0.18], [5.4, 0.08]].forEach(function (pp) {
      var o = ctx.createOscillator(); o.type = "sine";
      o.frequency.value = f * pp[0];
      var og = ctx.createGain(); og.gain.value = pp[1];
      o.connect(og).connect(g); o.start(t); o.stop(t + 1.0);
    });
    adsr(g.gain, t, 0.2, 0.002, 0.5, 0.001, 0, 0.4);
  }

  function guitar(f, t, dur) {
    var o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
    wowWire(o);
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1500; lp.Q.value = 4;
    var g = ctx.createGain(); g.gain.value = 0.0001;
    o.connect(lp).connect(g).connect(musicDuck);
    sendReverb(g, 0.25);
    adsr(g.gain, t, 0.18, 0.006, 0.18, 0.12, dur * 0.4, 0.35);
    o.start(t); o.stop(t + dur + 0.6);
  }

  function bass(f, t, dur) {
    var o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f;
    var o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = f;
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 320;
    var g = ctx.createGain(); g.gain.value = 0.0001;
    o.connect(lp); o2.connect(lp); lp.connect(g).connect(musicDuck);
    adsr(g.gain, t, 0.32, 0.02, 0.15, 0.7, dur, 0.18);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.3); o2.stop(t + dur + 0.3);
  }

  function lead(kind, f, t, dur) {
    if (kind === "rhodes") rhodes(f, t, dur);
    else if (kind === "glock") glock(f, t);
    else if (kind === "guitar") guitar(f, t, dur);
    else chop(f, t);
  }

  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function smp(buf, t, gv, rate, dest, panV) {
    if (!buf) return;
    var s = ctx.createBufferSource(); s.buffer = buf;
    if (rate) s.playbackRate.value = rate;
    var g = ctx.createGain(); g.gain.value = gv;
    if (ctx.createStereoPanner && panV != null) {
      var pn = ctx.createStereoPanner(); pn.pan.value = panV;
      s.connect(pn).connect(g);
    } else { s.connect(g); }
    g.connect(dest || drumsBus);
    s.start(t);
    return s;
  }

  function chop(f, t) {
    if (!LIB.chop.length) { glock(f, t); return; }
    var b = pick(LIB.chop);
    // nudge the chop toward the current harmony; vocal chops are forgiving
    var rate = Math.pow(2, ((Math.random() * 5 | 0) - 2) / 12);
    var g = ctx.createGain(); g.gain.value = 0.0001;
    g.connect(musicDuck); sendReverb(g, 0.4);
    var s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    var slice = Math.min(b.duration, 0.5 + Math.random() * 0.9);
    s.connect(g); s.start(t, Math.random() * Math.max(0, b.duration - slice), slice);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + slice + 0.15);
  }

  // sidechain pump on every kick
  function duck(t) {
    var p = musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(1, t);
    p.linearRampToValueAtTime(0.42, t + 0.012);
    p.setTargetAtTime(1, t + 0.02, 0.085);
  }

  function kick(t) {
    if (LIB.kick.length) { smp(pick(LIB.kick), t, 0.7); duck(t); return; }
    // synth fallback only if no samples (kept minimal; samples are the path)
    var o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(drumsBus); o.start(t); o.stop(t + 0.32);
    duck(t);
  }

  // ---- scheduler -----------------------------------------------------------
  var running = false, timer = null, step16 = 0, nextTime = 0, started = false;
  var skipping = false;

  function chordForBar(barIndex) {
    var slot = Math.floor((barIndex / cfg.barsPerChord)) % cfg.prog.length;
    var color = Math.random() < 0.3 ? "add9" : (Math.random() < 0.12 ? "sus" : "");
    return chordMidi(cfg.scale, cfg.root + 12, cfg.prog[slot], color);
  }

  function scheduleStep(s, t) {
    var bar = cfg.bar;
    var inTrans = bar >= cfg.totalBars - cfg.transBars;
    var dens = (inTrans ? 0.7 : 1) * (cfg.dens || 1);    // per-track busyness; thins gently at the seam
    var chord = chordForBar(bar);

    // --- drums (boom-bap, swung, humanized, slightly behind) ---
    var beat = Math.floor(s / 4);
    var kp = cfg.kickPat;
    var kickHit = (s === 0) ||
      (kp === 0 && s === 10) ||
      (kp === 1 && (s === 6 || s === 11)) ||
      (kp === 2 && s === 7);
    if (kickHit) kick(t);

    if (s === 4 || s === 12) {                            // backbeat snare
      var sn = LIB.snare.length ? pick(LIB.snare) : null;
      if (sn) smp(sn, t + 0.012, 0.8);
    } else if (LIB.snare.length && Math.random() < 0.06 * dens) {
      smp(pick(LIB.snare), t + 0.012, 0.18);              // ghost
    }

    if (s % 2 === 0 || Math.random() < 0.4 * dens) {      // loose hats
      var openTime = (s === 14 && Math.random() < 0.5);
      var hb = openTime && LIB.hatO.length ? pick(LIB.hatO)
             : LIB.hatC.length ? pick(LIB.hatC) : null;
      if (hb) smp(hb, t + 0.006 + Math.random() * 0.012,
                  (0.22 + Math.random() * 0.16) * (openTime ? 1.1 : 1));
    }
    if (LIB.shaker.length && s % 4 === 2 && Math.random() < 0.5 * dens)
      smp(pick(LIB.shaker), t + 0.01, 0.16);
    if (LIB.perc.length && Math.random() < 0.03 * dens)
      smp(pick(LIB.perc), t + 0.01, 0.18, 1, drumsBus,
          (Math.random() * 2 - 1) * 0.5);

    // --- harmony / bass / lead on musical positions ---
    if (s === 0) {
      pad(chord.map(mtof), t, cfg.barDur * cfg.barsPerChord * 0.98);
      bass(mtof(chord[0] - 24), t, cfg.barDur * 0.92);
      if (!inTrans && Math.random() < 0.6)
        rhodes(mtof(chord[1]), t + 0.02, cfg.barDur * 0.5);
    }
    if (s === 8) {
      bass(mtof(chord[0] - 24 + (Math.random() < 0.5 ? 7 : 0)), t, cfg.barDur * 0.45);
      if (!inTrans && Math.random() < 0.5)
        rhodes(mtof(pick([chord[2], chord[3]])), t, cfg.barDur * 0.45);
    }
    // sparse melodic top — never busy
    if (!inTrans && (s === 6 || s === 11) && Math.random() < 0.32) {
      var top = mtof(pick(chord) + 12);
      lead(cfg.lead, top, t + 0.02, cfg.barDur * 0.4);
    }

    // --- end of bar bookkeeping ---
    if (s === 15) {
      cfg.bar++;
      if (cfg.bar >= cfg.totalBars) nextTrack(t + (60 / cfg.bpm / 4));
    }
  }

  // Shared crossfade-style transition: dip the master, swap to a fresh
  // config + vinyl while it's quiet, then ride back up. Used by BOTH the
  // automatic end-of-track seam and the manual skip, so every track change
  // feels like a mix transition rather than a hard cut. The 4-bar density
  // thin-out already in scheduleStep leads into this dip.
  function transition(outS, holdMs, inS) {
    if (!running || skipping || !ctx) return;
    skipping = true;
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0.0001, t + outS);
    setTimeout(function () {
      if (!running) { skipping = false; return; }
      cfg = newConfig(); step16 = 0;
      nextTime = ctx.currentTime + 0.1;
      applyTrack();
      swapVinyl();
      fireTrack();
      var t2 = ctx.currentTime;
      master.gain.cancelScheduledValues(t2);
      master.gain.setValueAtTime(0.0001, t2);
      master.gain.linearRampToValueAtTime(prefs.vol, t2 + inS);
      skipping = false;
    }, holdMs);
  }
  // automatic end-of-track seam: gentler/quicker than a manual skip
  function nextTrack() { transition(0.32, 360, 0.7); }

  // ---- texture (vinyl crackle loop + tape hiss; synth backup) -------------
  var vinylSrc = null, vinylGain = null, vinylBuf = null, hissNode = null;
  function swapVinyl() {
    var t = ctx.currentTime;
    if (LIB.vinyl.length) {
      var b = LIB.vinyl[(Math.random() * LIB.vinyl.length) | 0];
      if (b === vinylBuf && vinylSrc) return;        // already on this loop — no needless swap
      var old = vinylSrc, oldG = vinylGain;
      if (old && oldG) {                             // cross-fade, never a gap in the crackle
        oldG.gain.cancelScheduledValues(t);
        oldG.gain.setValueAtTime(oldG.gain.value, t);
        oldG.gain.linearRampToValueAtTime(0.0001, t + 0.6);
        try { old.stop(t + 0.65); } catch (e) {}
      }
      var s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
      var g = ctx.createGain(); g.gain.value = old ? 0.0001 : 0.5;
      s.connect(g).connect(texBus); s.start(t);
      if (old) g.gain.linearRampToValueAtTime(0.5, t + 0.6);
      vinylSrc = s; vinylGain = g; vinylBuf = b;
    } else if (!hissNode) {
      // synthesized crackle/hiss backup when no texture samples exist
      var len = ctx.sampleRate * 2;
      var nb = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = nb.getChannelData(0);
      for (var i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.004 ? 1 : 0.06);
      var ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
      var hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1400;
      var ng = ctx.createGain(); ng.gain.value = 0.5;
      ns.connect(hp).connect(ng).connect(texBus); ns.start(t);
      hissNode = ns;
    }
  }

  function scheduler() {
    if (!running) return;
    var stepDur = 60 / cfg.bpm / 4;
    while (nextTime < ctx.currentTime + AHEAD) {
      var swung = (step16 % 2 === 1) ? (cfg.swing - 0.5) * 2 * stepDur : 0;
      scheduleStep(step16, nextTime + swung);
      step16 = (step16 + 1) % 16;
      nextTime += stepDur;
    }
  }

  // ---- public API ----------------------------------------------------------
  function doStart() {
    if (!mkContext()) return false;
    if (running) return true;
    if (ctx.state === "suspended") ctx.resume();
    if (!cfg) cfg = newConfig();
    applyTrack();
    swapVinyl();
    step16 = 0;
    nextTime = ctx.currentTime + 0.15;
    running = true; started = true;
    timer = setInterval(scheduler, TICK);
    fireTrack();                       // announce the opening track
    return true;
  }

  function doStop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (vinylSrc) { try { vinylSrc.stop(); } catch (e) {} vinylSrc = null; }
    vinylGain = null; vinylBuf = null;
    if (hissNode) { try { hissNode.stop(); } catch (e) {} hissNode = null; }
    if (master && ctx) {
      var t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(0, t, 0.25);
      setTimeout(function () { if (!running && ctx) ctx.suspend(); }, 900);
    }
  }

  function fadeInMaster() {
    if (!ctx) return;
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(0.0001, t);
    master.gain.setTargetAtTime(prefs.vol, t, 0.4);
  }

  // transport — start/stop sound now WITHOUT touching the persisted
  // site-music preference (used by hosts that own playback, e.g. Roomtone)
  function play()  { var ok = doStart(); if (ok) fadeInMaster(); return ok; }
  function pause() { if (running) doStop(); }

  // auto-resume on the first real gesture, and auto-start if opted in.
  // autoplay can be disabled by a host that drives play()/pause() itself.
  var autoplay = true, armed = false;
  function arm() {
    if (armed) return; armed = true;
    function go() {
      window.removeEventListener("pointerdown", go, true);
      window.removeEventListener("keydown", go, true);
      if (ctx && ctx.state === "suspended") ctx.resume();
      if (autoplay && prefs.enabled && !running) play();
    }
    window.addEventListener("pointerdown", go, true);
    window.addEventListener("keydown", go, true);
  }

  var API = {
    // Play/stop right now without changing the saved site-music preference.
    // Safe to call from a user-gesture handler.
    play: function () { return play(); },
    pause: function () { pause(); },
    // Disable first-gesture autoplay (host drives transport itself).
    setAutoplay: function (b) { autoplay = !!b; },
    // Begin playback AND opt the site music in (persisted).
    start: function () { prefs.enabled = true; persist(); return play(); },
    // Stop AND opt out (persisted) so site music stays quiet next visit.
    stop: function () { prefs.enabled = false; persist(); pause(); },
    // Jump immediately to a fresh generative track.
    skip: function () { transition(0.5, 560, 0.6); },
    // current track descriptor, or null when stopped
    nowPlaying: function () { return trackInfo(); },
    // host hook: called with trackInfo() whenever the track changes
    onTrack: function (fn) { onTrackCb = (typeof fn === "function") ? fn : null; },
    // 0..1; persists across sessions.
    setVolume: function (v) {
      v = Math.min(1, Math.max(0, +v || 0));
      prefs.vol = v; persist();
      if (master && ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
      return v;
    },
    getVolume: function () { return prefs.vol; },
    isPlaying: function () { return running; },
    isEnabled: function () { return prefs.enabled; },
    toggle: function () { return running ? (API.stop(), false) : (API.start(), true); }
  };

  window.LofiEngine = API;
  arm();   // respects autoplay policy: nothing sounds until a real gesture
})();
