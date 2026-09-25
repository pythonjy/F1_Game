(() => {
  "use strict";

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const minimap = document.getElementById("minimapCanvas");
  const miniCtx = minimap.getContext("2d");

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds)) return "--:--.---";
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
    const millis = Math.floor((seconds % 1) * 1000).toString().padStart(3, "0");
    return `${minutes}:${secs}.${millis}`;
  };
  const notify = (message, duration = 1200) => {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => toast.classList.remove("show"), duration);
  };

  const SEGMENT_LENGTH = 150;
  const DRAW_DISTANCE = 185;
  const TRACK = buildTrack();
  const TRACK_LENGTH = TRACK.length * SEGMENT_LENGTH;
  const CAR_PRESETS = {
    aurora: { name: "A-01 Aurora", topSpeed: 296, acceleration: 132, cornering: 1.0, color: "#55dcff", accent: "#effdff" },
    vortex: { name: "V-07 Vortex", topSpeed: 309, acceleration: 126, cornering: 0.86, color: "#ff765a", accent: "#fff3de" },
    comet: { name: "C-03 Comet", topSpeed: 288, acceleration: 145, cornering: 1.16, color: "#c28cff", accent: "#ffffff" }
  };
  const DIFFICULTY = { easy: 0.84, normal: 0.97, hard: 1.06 };
  const AI_COLORS = ["#ff5e5e", "#ffe07a", "#ff8b44", "#aa9aff", "#64e1ba", "#dbe8f1", "#ef65bb"];
  const audio = { context: null, engine: null, engineGain: null };

  const state = {
    mode: "menu",
    camera: "cockpit",
    carKey: "aurora",
    difficulty: "normal",
    laps: 3,
    weather: "day",
    distance: 0,
    speed: 0,
    playerX: 0,
    steer: 0,
    throttle: false,
    brake: false,
    keyboardSteer: 0,
    cars: [],
    raceStart: 0,
    elapsed: 0,
    lapStart: 0,
    bestLap: Infinity,
    topSpeed: 0,
    lastLap: 0,
    countdown: 3.4,
    lastFrame: performance.now(),
    viewWidth: 0,
    viewHeight: 0,
    dpr: 1,
    orientationSteer: 0,
    orientationReady: false,
    lastPosition: 8,
    collisionCooldown: 0,
    rainOffset: 0
  };

  function buildTrack() {
    const segments = [];
    const add = (name, count, curve = 0, hill = 0) => {
      for (let i = 0; i < count; i += 1) {
        const phase = count > 1 ? i / (count - 1) : 0.5;
        segments.push({
          name,
          curve: curve * (0.86 + Math.sin(phase * Math.PI) * 0.14),
          hill: hill * (0.88 + Math.sin(phase * Math.PI) * 0.12),
          index: segments.length
        });
      }
    };

    // A compact, mobile-friendly interpretation of Circuit de Monaco's corner rhythm.
    add("START / FINISH", 8, 0, 0);
    add("SAINTE DEVOTE", 6, -0.88, 0.04);
    add("BEAU RIVAGE", 8, 0.50, 0.12);
    add("MAS­SENET", 7, -0.62, 0.08);
    add("CASINO SQUARE", 6, 0.48, 0.02);
    add("MIRABEAU", 5, -0.46, -0.05);
    add("LOEWS HAIRPIN", 7, 0.96, -0.08);
    add("PORTIER", 5, -0.52, -0.04);
    add("TUNNEL", 11, 0.12, 0.05);
    add("NOUVELLE CHICANE", 6, -0.86, 0.02);
    add("TABAC", 5, 0.78, 0.04);
    add("SWIMMING POOL", 10, -0.74, 0.03);
    add("LA RASCASSE", 5, 0.83, -0.04);
    add("ANTHONY NOGHES", 6, -0.56, 0);
    add("START / FINISH", 6, 0.06, 0);

    let curveX = 0;
    let elevation = 0;
    segments.forEach((segment, index) => {
      curveX += segment.curve * 0.72;
      elevation += segment.hill * 10;
      segment.curveX = curveX;
      segment.elevation = elevation;
      segment.index = index;
    });
    return segments;
  }

  function getSegmentAt(distance) {
    const wrapped = ((distance % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
    return TRACK[Math.floor(wrapped / SEGMENT_LENGTH) % TRACK.length];
  }

  function wrapDistance(value) {
    return ((value % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    state.viewWidth = Math.max(320, rect.width);
    state.viewHeight = Math.max(240, rect.height);
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(state.viewWidth * state.dpr);
    canvas.height = Math.floor(state.viewHeight * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function initCars() {
    const difficultyFactor = DIFFICULTY[state.difficulty];
    state.cars = AI_COLORS.map((color, index) => ({
      id: index,
      distance: -index * 18 - 18,
      lane: [-0.52, 0.42, -0.2, 0.64, -0.68, 0.16, 0.5][index],
      baseLane: [-0.52, 0.42, -0.2, 0.64, -0.68, 0.16, 0.5][index],
      speed: (215 + index * 3) * difficultyFactor,
      targetSpeed: (226 + index * 3) * difficultyFactor,
      color,
      phase: index * 1.7,
      wobble: 0.4 + index * 0.08,
      finished: false
    }));
  }

  function readSetup() {
    state.carKey = $("carSelect").value;
    state.difficulty = $("difficultySelect").value;
    state.laps = Number($("lapsSelect").value);
    state.weather = $("weatherSelect").value;
  }

  async function requestTiltPermission() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const result = await DeviceOrientationEvent.requestPermission();
        state.orientationReady = result === "granted";
      } else {
        state.orientationReady = "DeviceOrientationEvent" in window;
      }
    } catch {
      state.orientationReady = false;
    }
    notify(state.orientationReady ? "기울기 조향 활성화" : "기울기 조향을 사용할 수 없어 버튼 조향으로 전환", 1600);
  }

  function startRace() {
    readSetup();
    initAudio();
    void requestTiltPermission();
    state.mode = "countdown";
    state.camera = "cockpit";
    state.distance = 0;
    state.speed = 0;
    state.playerX = 0;
    state.steer = 0;
    state.elapsed = 0;
    state.lapStart = 0;
    state.bestLap = Infinity;
    state.lastLap = 0;
    state.topSpeed = 0;
    state.countdown = 3.4;
    state.lastPosition = 8;
    state.collisionCooldown = 0;
    initCars();
    $("gameMenu").classList.add("is-hidden");
    $("resultPanel").classList.add("is-hidden");
    $("pausePanel").classList.add("is-hidden");
    $("hud").classList.remove("is-hidden");
    $("touchControls").classList.remove("is-hidden");
    $("pauseButton").classList.remove("is-hidden");
    $("cameraButton").classList.remove("is-hidden");
    updateHud();
  }

  function finishRace() {
    state.mode = "result";
    state.speed = 0;
    const bestKey = `apexBestLap_${state.laps}`;
    const previous = Number(localStorage.getItem(bestKey) || Infinity);
    const isRecord = state.bestLap < previous;
    if (isRecord && Number.isFinite(state.bestLap)) localStorage.setItem(bestKey, String(state.bestLap));
    $("resultPosition").textContent = `${state.lastPosition} / ${state.cars.length + 1}`;
    $("resultTime").textContent = formatTime(state.elapsed);
    $("resultBestLap").textContent = formatTime(state.bestLap);
    $("resultTopSpeed").textContent = `${Math.round(state.topSpeed)} KM/H`;
    $("newRecordText").classList.toggle("is-hidden", !isRecord);
    $("resultTitle").textContent = state.lastPosition === 1 ? "P1 · VICTORY" : "CHEQUERED FLAG";
    $("resultEyebrow").textContent = isRecord ? "PERSONAL BEST SET" : "RACE COMPLETE";
    $("hud").classList.add("is-hidden");
    $("touchControls").classList.add("is-hidden");
    $("pauseButton").classList.add("is-hidden");
    $("cameraButton").classList.add("is-hidden");
    $("resultPanel").classList.remove("is-hidden");
    stopEngineAudio();
    playEffect(state.lastPosition === 1 ? 880 : 640, 0.22, "triangle", 0.05);
    vibrate([35, 50, 80]);
  }

  function setPaused(paused) {
    if (state.mode === "result" || state.mode === "menu") return;
    state.mode = paused ? "paused" : "racing";
    $("pausePanel").classList.toggle("is-hidden", !paused);
    $("touchControls").classList.toggle("is-hidden", paused);
  }

  function toggleCamera() {
    if (state.mode !== "racing" && state.mode !== "countdown") return;
    state.camera = state.camera === "cockpit" ? "chase" : "cockpit";
    notify(state.camera === "cockpit" ? "COCKPIT VIEW" : "CHASE VIEW");
  }

  function currentSteer() {
    const buttonSteer = state.keyboardSteer || state.steer;
    const tiltSteer = state.orientationReady ? clamp(state.orientationSteer / 25, -1, 1) : 0;
    return state.keyboardSteer !== 0 || state.steer !== 0 ? buttonSteer : tiltSteer;
  }

  function update(dt) {
    if (state.mode === "countdown") {
      state.countdown -= dt;
      if (state.countdown <= 0) {
        state.mode = "racing";
        state.raceStart = performance.now();
        playEffect(520, 0.18, "square", 0.045);
        notify("GO!", 800);
        vibrate(35);
      }
      return;
    }
    if (state.mode !== "racing") return;

    state.elapsed += dt;
    state.collisionCooldown = Math.max(0, state.collisionCooldown - dt);
    const car = CAR_PRESETS[state.carKey];
    const input = currentSteer();
    const segment = getSegmentAt(state.distance);
    const cornerFactor = clamp(Math.abs(segment.curve), 0, 1);
    const traction = lerp(car.cornering, car.cornering * 0.66, cornerFactor);

    if (state.throttle) state.speed += car.acceleration * dt;
    else state.speed -= 22 * dt;
    if (state.brake) state.speed -= 245 * dt;
    state.speed -= Math.abs(input) * Math.max(0, state.speed - 90) * 0.012 * dt;
    state.speed = clamp(state.speed, 0, car.topSpeed);
    state.topSpeed = Math.max(state.topSpeed, state.speed);

    const roadGrip = state.playerX < -0.92 || state.playerX > 0.92 ? 0.52 : 1;
    const lateralRate = (0.82 + state.speed / 330) * traction * roadGrip;
    state.playerX += input * lateralRate * dt;
    state.playerX = clamp(state.playerX, -1.16, 1.16);
    if (roadGrip < 1) state.speed = Math.max(0, state.speed - 42 * dt);
    state.distance += state.speed * dt;
    state.rainOffset += dt * 240;

    state.cars.forEach((opponent) => {
      const upcoming = getSegmentAt(opponent.distance + 220);
      const curvePenalty = Math.abs(upcoming.curve) * 25;
      opponent.targetSpeed = (226 + opponent.id * 3) * DIFFICULTY[state.difficulty] - curvePenalty;
      opponent.speed = lerp(opponent.speed, Math.max(130, opponent.targetSpeed), dt * 1.2);
      opponent.distance += opponent.speed * dt;
      opponent.lane = opponent.baseLane + Math.sin(state.elapsed * opponent.wobble + opponent.phase) * 0.08;
      if (opponent.distance >= state.laps * TRACK_LENGTH) opponent.finished = true;

      const gap = opponent.distance - state.distance;
      if (state.collisionCooldown <= 0 && Math.abs(gap) < 70 && Math.abs(opponent.lane - state.playerX) < 0.22) {
        state.speed *= 0.56;
        state.playerX += opponent.lane > state.playerX ? -0.055 : 0.055;
        state.collisionCooldown = 1.0;
        playEffect(92, 0.12, "sawtooth", 0.06);
        vibrate([25, 30, 25]);
        notify("CONTACT", 650);
      }
    });

    const lapNumber = Math.floor(state.distance / TRACK_LENGTH);
    if (lapNumber > state.lastLap) {
      const lapTime = state.elapsed - state.lapStart;
      state.bestLap = Math.min(state.bestLap, lapTime);
      state.lapStart = state.elapsed;
      state.lastLap = lapNumber;
      notify(`LAP ${lapNumber} · ${formatTime(lapTime)}`, 1400);
      playEffect(760, 0.13, "triangle", 0.035);
      vibrate([24, 40, 24]);
    }
    state.lastPosition = 1 + state.cars.filter((opponent) => opponent.distance > state.distance).length;
    if (state.distance >= state.laps * TRACK_LENGTH) finishRace();
    updateHud();
  }

  function updateHud() {
    const lap = Math.min(state.laps, Math.floor(state.distance / TRACK_LENGTH) + 1);
    const segment = getSegmentAt(state.distance);
    $("speedValue").textContent = Math.round(state.speed).toString().padStart(3, "0");
    $("lapValue").textContent = `${lap}/${state.laps}`;
    $("positionValue").textContent = `${state.lastPosition}/${state.cars.length + 1}`;
    $("timerValue").textContent = formatTime(state.elapsed);
    $("sectorValue").textContent = `SECTOR ${Math.min(3, Math.floor((getSegmentAt(state.distance).index / TRACK.length) * 3) + 1)} · ${segment.name}`;
  }

  function drawSky() {
    const { viewWidth: w, viewHeight: h } = state;
    let top = "#071421";
    let bottom = "#6b9aa9";
    if (state.weather === "dusk") { top = "#160e2c"; bottom = "#d68166"; }
    if (state.weather === "night") { top = "#02050e"; bottom = "#1c3150"; }
    if (state.weather === "rain") { top = "#182832"; bottom = "#78949a"; }
    const gradient = ctx.createLinearGradient(0, 0, 0, h * 0.58);
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    if (state.weather === "night") {
      ctx.fillStyle = "rgba(222,240,255,.65)";
      for (let i = 0; i < 55; i += 1) {
        const x = (i * 97) % w;
        const y = (i * 43) % (h * 0.38);
        ctx.fillRect(x, y, 1.2, 1.2);
      }
    } else {
      const sunX = state.weather === "dusk" ? w * .72 : w * .78;
      const sunY = state.weather === "dusk" ? h * .26 : h * .16;
      const sun = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, 120);
      sun.addColorStop(0, state.weather === "dusk" ? "rgba(255,220,164,.9)" : "rgba(255,255,231,.75)");
      sun.addColorStop(1, "transparent");
      ctx.fillStyle = sun;
      ctx.fillRect(sunX - 140, sunY - 140, 280, 280);
    }
  }

  function drawHorizon() {
    const { viewWidth: w, viewHeight: h } = state;
    const horizon = h * 0.41;
    ctx.fillStyle = state.weather === "night" ? "#0b202d" : "#3d7887";
    ctx.fillRect(0, horizon, w, h * 0.14);
    ctx.fillStyle = state.weather === "night" ? "rgba(18,39,58,.9)" : "rgba(216,230,225,.68)";
    ctx.beginPath();
    ctx.moveTo(0, horizon + 26);
    for (let x = 0; x <= w; x += 28) ctx.lineTo(x, horizon + 22 + Math.sin(x * .022) * 11);
    ctx.lineTo(w, horizon + 90); ctx.lineTo(0, horizon + 90); ctx.closePath(); ctx.fill();

    ctx.fillStyle = state.weather === "night" ? "#172b3a" : "#536d72";
    for (let i = 0; i < 30; i += 1) {
      const x = i * (w / 29) + Math.sin(i * 4.1) * 10;
      const width = 12 + (i % 4) * 7;
      const height = 22 + (i % 7) * 9;
      ctx.fillRect(x, horizon + 26 - height, width, height);
      if (state.weather === "night" && i % 2 === 0) {
        ctx.fillStyle = "rgba(255,205,106,.55)";
        ctx.fillRect(x + 3, horizon + 17 - height, 2, 3);
        ctx.fillStyle = "#172b3a";
      }
    }
  }

  function projectRoadSample(distance, currentCurveX, playerX) {
    const { viewWidth: w, viewHeight: h } = state;
    const normalized = clamp(distance / (DRAW_DISTANCE * SEGMENT_LENGTH), 0, 1);
    const p = 1 - normalized;
    const y = h * 0.42 + Math.pow(p, 1.54) * (h * 0.7);
    const segment = getSegmentAt(state.distance + distance);
    const curveShift = (segment.curveX - currentCurveX) * 0.42 * Math.pow(p, 1.12);
    const halfWidth = 4 + Math.pow(p, 1.13) * w * 0.48;
    const center = w / 2 + curveShift - playerX * halfWidth * 0.42;
    return { segment, y, center, halfWidth, p };
  }

  function drawRoad() {
    const { viewWidth: w, viewHeight: h } = state;
    const current = getSegmentAt(state.distance);
    let previous = projectRoadSample(DRAW_DISTANCE * SEGMENT_LENGTH, current.curveX, state.playerX);
    for (let n = DRAW_DISTANCE - 1; n >= 0; n -= 1) {
      const sample = projectRoadSample(n * SEGMENT_LENGTH, current.curveX, state.playerX);
      const even = Math.floor((state.distance / SEGMENT_LENGTH + n) % 2) === 0;
      const grassA = state.weather === "night" ? "#0c2826" : even ? "#1d6548" : "#236f4f";
      const road = state.weather === "rain" ? (even ? "#3a4b51" : "#42555b") : (even ? "#3a444e" : "#414c57");
      ctx.fillStyle = grassA;
      ctx.beginPath();
      ctx.moveTo(0, previous.y); ctx.lineTo(w, previous.y); ctx.lineTo(w, sample.y); ctx.lineTo(0, sample.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = road;
      ctx.beginPath();
      ctx.moveTo(previous.center - previous.halfWidth, previous.y);
      ctx.lineTo(previous.center + previous.halfWidth, previous.y);
      ctx.lineTo(sample.center + sample.halfWidth, sample.y);
      ctx.lineTo(sample.center - sample.halfWidth, sample.y);
      ctx.closePath(); ctx.fill();

      const curbColor = Math.floor((state.distance / SEGMENT_LENGTH + n) / 2) % 2 === 0 ? "#f7f7eb" : "#e24c4c";
      const curbWidth = Math.max(1, sample.halfWidth * 0.055);
      ctx.fillStyle = curbColor;
      ctx.beginPath();
      ctx.moveTo(previous.center - previous.halfWidth, previous.y);
      ctx.lineTo(previous.center - previous.halfWidth + previous.halfWidth * .06, previous.y);
      ctx.lineTo(sample.center - sample.halfWidth + sample.halfWidth * .06, sample.y);
      ctx.lineTo(sample.center - sample.halfWidth, sample.y); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(previous.center + previous.halfWidth, previous.y);
      ctx.lineTo(previous.center + previous.halfWidth - previous.halfWidth * .06, previous.y);
      ctx.lineTo(sample.center + sample.halfWidth - sample.halfWidth * .06, sample.y);
      ctx.lineTo(sample.center + sample.halfWidth, sample.y); ctx.closePath(); ctx.fill();

      if (sample.segment.name === "START / FINISH" && sample.segment.index % 2 === 0 && sample.p > .45) {
        ctx.fillStyle = "rgba(245,250,250,.85)";
        const lineWidth = Math.max(2, sample.halfWidth * .035);
        ctx.fillRect(sample.center - sample.halfWidth * .78, sample.y - lineWidth, sample.halfWidth * 1.56, lineWidth);
      }
      previous = sample;
    }
    if (state.weather === "rain") drawRain();
  }

  function drawRain() {
    const { viewWidth: w, viewHeight: h } = state;
    ctx.strokeStyle = "rgba(190,230,240,.26)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 90; i += 1) {
      const x = (i * 83 + state.rainOffset * (i % 3 + 1)) % (w + 80) - 40;
      const y = (i * 47 + state.rainOffset * 1.6) % h;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 7, y + 18); ctx.stroke();
    }
  }

  function drawCar(x, y, scale, color, isPlayer = false, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const width = (isPlayer ? 132 : 43) * scale;
    const height = (isPlayer ? 62 : 30) * scale;
    ctx.translate(x, y - height * .8);
    ctx.fillStyle = "rgba(0,0,0,.36)";
    ctx.beginPath(); ctx.ellipse(0, height * .76, width * .72, height * .17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-width * .72, height * .45);
    ctx.lineTo(-width * .28, height * .26);
    ctx.lineTo(-width * .08, -height * .04);
    ctx.lineTo(width * .08, -height * .04);
    ctx.lineTo(width * .28, height * .26);
    ctx.lineTo(width * .72, height * .45);
    ctx.lineTo(width * .55, height * .64);
    ctx.lineTo(-width * .55, height * .64);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#111a22";
    ctx.beginPath(); ctx.moveTo(-width * .16, height * .02); ctx.lineTo(width * .16, height * .02); ctx.lineTo(width * .26, height * .3); ctx.lineTo(-width * .26, height * .3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = isPlayer ? CAR_PRESETS[state.carKey].accent : "#d8e4ec";
    ctx.fillRect(-width * .83, height * .5, width * 1.66, Math.max(2, height * .08));
    ctx.fillStyle = "#0a1016";
    ctx.fillRect(-width * .68, height * .58, width * .22, height * .18);
    ctx.fillRect(width * .46, height * .58, width * .22, height * .18);
    ctx.restore();
  }

  function drawOpponentCars() {
    const current = getSegmentAt(state.distance);
    state.cars.forEach((opponent) => {
      const relative = opponent.distance - state.distance;
      if (relative < 15 || relative > DRAW_DISTANCE * SEGMENT_LENGTH) return;
      const projected = projectRoadSample(relative, current.curveX, state.playerX);
      const laneOffset = opponent.lane * projected.halfWidth * .58;
      const scale = .16 + projected.p * .92;
      drawCar(projected.center + laneOffset, projected.y, scale, opponent.color, false, .96);
    });
  }

  function drawPlayerCar() {
    const { viewWidth: w, viewHeight: h } = state;
    if (state.camera === "chase") {
      drawCar(w / 2 + state.playerX * 48, h * .89, 1.24, CAR_PRESETS[state.carKey].color, true);
      return;
    }
    const gradient = ctx.createLinearGradient(0, h * .72, 0, h);
    gradient.addColorStop(0, "rgba(4,12,20,.15)");
    gradient.addColorStop(.22, "rgba(4,12,20,.78)");
    gradient.addColorStop(1, "#04080d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, h * .72, w, h * .28);
    ctx.fillStyle = "rgba(174, 221, 236, .2)";
    ctx.beginPath(); ctx.moveTo(w * .28, h); ctx.lineTo(w * .43, h * .76); ctx.lineTo(w * .57, h * .76); ctx.lineTo(w * .72, h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = CAR_PRESETS[state.carKey].color;
    ctx.beginPath(); ctx.moveTo(w * .34, h); ctx.lineTo(w * .44, h * .79); ctx.lineTo(w * .56, h * .79); ctx.lineTo(w * .66, h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#0b1720";
    ctx.beginPath(); ctx.arc(w / 2, h * .91, Math.min(w, h) * .12, Math.PI, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(224,244,255,.72)";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(w / 2, h * .91, Math.min(w, h) * .12, Math.PI, Math.PI * 2); ctx.stroke();
  }

  function drawCountdown() {
    if (state.mode !== "countdown") return;
    const { viewWidth: w, viewHeight: h } = state;
    const number = state.countdown > 3 ? "3" : state.countdown > 2 ? "2" : state.countdown > 1 ? "1" : "GO";
    ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.min(w, h) * .19}px ui-monospace, monospace`;
    ctx.fillStyle = number === "GO" ? "#8fffd1" : "#f5fbff";
    ctx.shadowColor = number === "GO" ? "rgba(143,255,209,.65)" : "rgba(99,230,255,.55)";
    ctx.shadowBlur = 26; ctx.fillText(number, w / 2, h * .45); ctx.restore();
  }

  function drawScene() {
    const { viewWidth: w, viewHeight: h } = state;
    ctx.clearRect(0, 0, w, h);
    drawSky();
    drawHorizon();
    drawRoad();
    drawOpponentCars();
    if (state.mode === "racing" || state.mode === "countdown") drawPlayerCar();
    drawCountdown();
    drawMinimap();
  }

  function drawMinimap() {
    const w = minimap.width; const h = minimap.height;
    miniCtx.clearRect(0, 0, w, h);
    miniCtx.fillStyle = "rgba(4,14,23,.93)"; miniCtx.fillRect(0, 0, w, h);
    const points = [];
    let x = 0; let y = 0; let heading = -Math.PI * .25;
    TRACK.forEach((segment) => {
      heading += segment.curve * .025;
      x += Math.cos(heading) * 4.4;
      y += Math.sin(heading) * 4.4;
      points.push({ x, y });
    });
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const sx = (w - 22) / Math.max(1, maxX - minX);
    const sy = (h - 22) / Math.max(1, maxY - minY);
    const scale = Math.min(sx, sy);
    const mapPoint = (point) => ({ x: 11 + (point.x - minX) * scale + (w - 22 - (maxX - minX) * scale) / 2, y: 11 + (point.y - minY) * scale + (h - 22 - (maxY - minY) * scale) / 2 });
    miniCtx.lineWidth = 7; miniCtx.lineCap = "round"; miniCtx.lineJoin = "round"; miniCtx.strokeStyle = "rgba(149,173,186,.25)";
    miniCtx.beginPath(); points.forEach((point, index) => { const p = mapPoint(point); if (index === 0) miniCtx.moveTo(p.x, p.y); else miniCtx.lineTo(p.x, p.y); }); miniCtx.stroke();
    miniCtx.lineWidth = 2; miniCtx.strokeStyle = "#9ceeff"; miniCtx.stroke();
    const playerIndex = Math.floor((wrapDistance(state.distance) / TRACK_LENGTH) * (points.length - 1));
    const playerPoint = mapPoint(points[playerIndex] || points[0]);
    miniCtx.fillStyle = "#63e6ff"; miniCtx.beginPath(); miniCtx.arc(playerPoint.x, playerPoint.y, 4, 0, Math.PI * 2); miniCtx.fill();
    state.cars.forEach((opponent) => {
      const index = Math.floor((wrapDistance(opponent.distance) / TRACK_LENGTH) * (points.length - 1));
      const point = mapPoint(points[index] || points[0]);
      miniCtx.fillStyle = opponent.color; miniCtx.beginPath(); miniCtx.arc(point.x, point.y, 2.5, 0, Math.PI * 2); miniCtx.fill();
    });
  }

  function gameLoop(now) {
    const dt = Math.min(.05, Math.max(0, (now - state.lastFrame) / 1000));
    state.lastFrame = now;
    update(dt);
    updateEngineAudio();
    drawScene();
    window.requestAnimationFrame(gameLoop);
  }

  function bindHold(id, key, value) {
    const element = $(id);
    const start = (event) => { event.preventDefault(); state[key] = value; element.classList.add("active"); };
    const end = (event) => { event.preventDefault(); if (state[key] === value) state[key] = key === "steer" ? 0 : false; element.classList.remove("active"); };
    ["pointerdown", "touchstart"].forEach((eventName) => element.addEventListener(eventName, start, { passive: false }));
    ["pointerup", "pointercancel", "pointerleave", "touchend", "touchcancel"].forEach((eventName) => element.addEventListener(eventName, end, { passive: false }));
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function initAudio() {
    if (audio.context) {
      if (audio.context.state === "suspended") void audio.context.resume();
      return;
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audio.context = new AudioContext();
      audio.engine = audio.context.createOscillator();
      audio.engine.type = "sawtooth";
      audio.engine.frequency.value = 70;
      audio.engineGain = audio.context.createGain();
      audio.engineGain.gain.value = 0;
      audio.engine.connect(audio.engineGain).connect(audio.context.destination);
      audio.engine.start();
    } catch {
      audio.context = null;
    }
  }

  function updateEngineAudio() {
    if (!audio.context || !audio.engine || !audio.engineGain) return;
    const active = state.mode === "racing" || state.mode === "countdown";
    const targetGain = active ? (state.throttle ? 0.035 : 0.012) : 0;
    const targetFrequency = 62 + state.speed * 0.78;
    const now = audio.context.currentTime;
    audio.engine.frequency.setTargetAtTime(targetFrequency, now, 0.045);
    audio.engineGain.gain.setTargetAtTime(targetGain, now, 0.08);
  }

  function stopEngineAudio() {
    if (!audio.context || !audio.engineGain) return;
    audio.engineGain.gain.setTargetAtTime(0, audio.context.currentTime, 0.05);
  }

  function playEffect(frequency, duration, type, volume) {
    if (!audio.context) return;
    try {
      const oscillator = audio.context.createOscillator();
      const gain = audio.context.createGain();
      const now = audio.context.currentTime;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(42, frequency * 0.72), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      oscillator.connect(gain).connect(audio.context.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    } catch {
      // Audio is optional; gameplay remains usable when the browser blocks it.
    }
  }

  function refreshBestTime() {
    const best = Number(localStorage.getItem(`apexBestLap_${Number($("lapsSelect").value)}`) || Infinity);
    $("bestTimeMenu").textContent = formatTime(best);
  }

  function resetToMenu() {
    state.mode = "menu";
    $("resultPanel").classList.add("is-hidden");
    $("pausePanel").classList.add("is-hidden");
    $("hud").classList.add("is-hidden");
    $("touchControls").classList.add("is-hidden");
    $("pauseButton").classList.add("is-hidden");
    $("cameraButton").classList.add("is-hidden");
    $("gameMenu").classList.remove("is-hidden");
    refreshBestTime();
  }

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => window.setTimeout(resize, 200));
  window.addEventListener("deviceorientation", (event) => {
    if (typeof event.gamma === "number") state.orientationSteer = event.gamma;
  }, true);

  $("startButton").addEventListener("click", startRace);
  $("againButton").addEventListener("click", startRace);
  $("garageButton").addEventListener("click", resetToMenu);
  $("pauseButton").addEventListener("click", () => setPaused(true));
  $("resumeButton").addEventListener("click", () => setPaused(false));
  $("quitButton").addEventListener("click", resetToMenu);
  $("cameraButton").addEventListener("click", toggleCamera);
  $("lapsSelect").addEventListener("change", refreshBestTime);
  canvas.addEventListener("dblclick", toggleCamera);

  bindHold("leftButton", "steer", -1);
  bindHold("rightButton", "steer", 1);
  bindHold("brakeButton", "brake", true);
  bindHold("throttleButton", "throttle", true);

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") state.keyboardSteer = -1;
    if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") state.keyboardSteer = 1;
    if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") state.throttle = true;
    if (event.key === "ArrowDown" || event.key.toLowerCase() === "s") state.brake = true;
    if (event.key.toLowerCase() === "c") toggleCamera();
    if (event.key === "Escape") setPaused(state.mode !== "paused");
  });
  window.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "a", "A", "ArrowRight", "d", "D"].includes(event.key)) state.keyboardSteer = 0;
    if (["ArrowUp", "w", "W"].includes(event.key)) state.throttle = false;
    if (["ArrowDown", "s", "S"].includes(event.key)) state.brake = false;
  });

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  resize();
  refreshBestTime();
  window.requestAnimationFrame(gameLoop);
})();
